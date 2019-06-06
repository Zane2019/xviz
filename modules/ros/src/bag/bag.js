// Copyright (c) 2019 Uber Technologies, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
/* global Buffer */
/* eslint-disable camelcase */
import {open, TimeUtil} from 'rosbag';
import {quaternionToEuler} from '../common/quaternion';

import {XVIZMetadataBuilder} from '@xviz/builder';

/* subclass Bag?
 *
 * keyTopic, topic filter
 *
 * init underlying data source
 * manage "configuration"
 *
 * reconfigure
 * critical topics and building messages
 * - message by topic
 * - message by time
 *
 * // tool to create this automagically
 *
 * -- rosbag xviz mapping
 * keyTopic: '',
 * // identity, unless frame_id
 * // confused by frame_id & child_frame_id
 * topicToXVIZ: /topic: {
 *  stream: '/foo',
 *  frame:
 *    frame_id: velodyne
 *    xviz_coordinate: VEHICLE_RELATIVE
 *
 *  streamStyle:
 *  styleClasses:
 *    name
 *    style
 *
 *  marker
 *    polyline
 *    polygon
 *    circle
 *    text
 *
 * @xviz topic to converter
 *
 */
export class Bag {
  constructor(bagPath, topicConfig) {
    this.bagPath = bagPath;
    this.keyTopic = topicConfig.keyTopic;
    this.topics = topicConfig.topics;
  }

  /**
   * Clients should subclass and override this method
   * in order to support any special processing for their specific
   * topics.
   * call to ensure we only need to make a single bag read.
   *
   * Extracts:
   *   frameIdToPoseMap: ROS /tf transform tree
   *   start_time,
   *   end_time,
   *   origin: map origin
   */
  async _initBag(context, bag) {
    const TF = '/tf';
    // TODO: this needs to be fixed in a general fashion
    // by letting a subclass method provide this data
    const CONFIGURATION = '/commander/configuration';

    let origin = {latitude: 0, longitude: 0, altitude: 0};
    const frameIdToPoseMap = {};

    const start_time = TimeUtil.toDate(bag.startTime).getTime() / 1e3;
    const end_time = TimeUtil.toDate(bag.endTime).getTime() / 1e3;

    await bag.readMessages({topics: [CONFIGURATION, TF]}, ({topic, message}) => {
      if (topic === CONFIGURATION) {
        const config = message.keyvalues.reduce((memo, kv) => {
          memo[kv.key] = kv.value;
          return memo;
        }, {});

        if (config.map_lat) {
          origin = {
            latitude: parseFloat(config.map_lat),
            longitude: parseFloat(config.map_lng),
            altitude: parseFloat(config.map_alt)
          };
        }
      } else if (topic === TF) {
        message.transforms.forEach(t => {
          frameIdToPoseMap[t.child_frame_id] = {
            ...t.transform.translation,
            ...quaternionToEuler(t.transform.rotation)
          };
        });
      }
    });

    context.start_time = start_time;
    context.end_time = end_time;
    context.origin = origin;
    context.frameIdToPoseMap = frameIdToPoseMap;
  }

  _initTopics(context, topicMessageTypes, ros2xviz) {
    // context { frameIdToPoseMap, origin }
    ros2xviz.initializeConverters(topicMessageTypes, context);
  }

  /* Open the ROS Bag and collect information
   *
   * TODO: option to not process topics if we have a configuration already mapped
   *       as that takes time
   */
  async init(ros2xviz) {
    const bag = await open(this.bagPath);

    const context = {};
    await this._initBag(context, bag);

    // TODO: Add option to not collect topic message types
    //      ... but how will converters be created then?
    //      The provider has the mapping, and it can decide if it wants
    //      to collect all topicTypes or not
    //      ... it is possible to save the message Types in the config
    //      ... is it possible to "create" them upon first sight?
    //           but then we have to keep track of which topics are being tracked
    const topicType = {};
    const topicMessageTypes = [];
    for (const conn in bag.connections) {
      const {topic, type} = bag.connections[conn];
      if (!this.topics || this.topics.includes(topic)) {
        // Validate that the message type does not change
        if (topicType[topic] && topicType[topic].type !== type) {
          throw new Error(
            `Unexpected change in topic type ${topic} has ${
              topicType[topic].type
            } with new type ${type}`
          );
        } else if (!topicType[topic]) {
          // track we have seen it and add to list
          topicType[topic] = {type};
          topicMessageTypes.push({topic, type});
        }
      }
    }
    this.topicMessageTypes = topicMessageTypes;

    this._initTopics(context, this.topicMessageTypes, ros2xviz);

    const xvizMetadataBuilder = new XVIZMetadataBuilder();
    await ros2xviz.buildMetadata(xvizMetadataBuilder, context);
    // Note: this does not have the envelope
    this.metadata = xvizMetadataBuilder.getMetadata();

    this.metadata.log_info = {
      start_time: context.start_time,
      end_time: context.end_time
    };

    // TODO: this would be client augmented metadata
    // this.metadata = this._initMetadata(this.metadata);
    const FORWARD_CENTER = '/vehicle/camera/center_front'; // example
    const CENTER_FRONT = '/vehicle/camera/forward_center/image_raw/compressed'; // dc golf

    this.metadata.ui_config = {
      Camera: {
        type: 'panel',
        children: [
          {
            type: 'video',
            cameras: [FORWARD_CENTER, CENTER_FRONT]
          }
        ],
        name: 'Camera'
      }
    };

    this.xvizMetadata = {
      type: 'xviz/metadata',
      data: this.metadata
    };

    return this.xvizMetadata;
  }

  // We synchronize xviz messages along messages in the `keyTopic`.
  async readMessageByTime(start, end) {
    const bag = await open(this.bagPath);
    const frame = {};

    const options = {};

    if (start) {
      options.startTime = TimeUtil.fromDate(new Date(start * 1e3));
    }

    if (end) {
      options.endTime = TimeUtil.fromDate(new Date(end * 1e3));
    }

    if (this.topics) {
      options.topics = this.topics;
    }

    await bag.readMessages(options, async result => {
      // rosbag.js reuses the data buffer for subsequent messages, so we need to make a copy
      if (result.message.data) {
        // TODO(this needs to work in the browser)
        result.message.data = Buffer.from(result.message.data);
      }

      if (result.topic === this.keyTopic) {
        frame.keyTopic = result;
      }

      frame[result.topic] = frame[result.topic] || [];
      frame[result.topic].push(result);
    });

    return frame;
  }

  // TODO: move this to a differrent BagClass
  // We synchronize messages along messages in the `keyTopic`.
  async readMessageByKeyTopic(start, end) {
    const bag = await open(this.bagPath);
    let frame = {};

    async function flushMessage() {
      if (frame.keyTopic) {
        // This needs to be address, was used to flush on keyTopic message to sync
        // await onMessage(frame);
        frame = {};
      }
    }

    const options = {
      startTime: TimeUtil.fromDate(new Date(start * 1e3)),
      endTime: TimeUtil.fromDate(new Date(end * 1e3))
    };

    if (this.topics) {
      options.topics = this.topics;
    }

    await bag.readMessages(options, async result => {
      // rosbag.js reuses the data buffer for subsequent messages, so we need to make a copy
      if (result.message.data) {
        result.message.data = Buffer.from(result.message.data);
      }
      if (result.topic === this.keyTopic) {
        await flushMessage();
        frame.keyTopic = result;
      }
      frame[result.topic] = frame[result.topic] || [];
      frame[result.topic].push(result);
    });

    // Flush the final frame
    await flushMessage();
  }
}
