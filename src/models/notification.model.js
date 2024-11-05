"use strict";

const { model, Schema } = require("mongoose");
const { convertToArray } = require("../utils");
const { NOTIFICATION_TYPES } = require("../constants");

const DOCUMENT_NAME = "Notification";
const COLLECTION_NAME = "Notifications";

const notificationSchema = new Schema(
  {
    notification_type: {
      type: String,
      enum: convertToArray(NOTIFICATION_TYPES),
      required: true,
    },
    notification_sender_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    notification_receiver_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    notification_content: {
      type: String,
      required: true,
    },
    notification_options: {
      type: Object,
      default: {},
    },
  },
  {
    collection: COLLECTION_NAME,
    timestamps: true,
  }
);

module.exports = model(DOCUMENT_NAME, notificationSchema, COLLECTION_NAME);
