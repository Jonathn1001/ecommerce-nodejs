"use strict";

const { model, Schema } = require("mongoose");

const DOCUMENT_NAME = "Comment";
const COLLECTION_NAME = "Comments";

const commentSchema = new Schema(
  {
    comment_product_id: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    comment_user_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    comment_content: {
      type: String,
      required: true,
    },
    comment_left: {
      type: Number,
      default: 0,
    },
    comment_right: {
      type: Number,
      default: 0,
    },
    comment_parent_id: {
      type: Schema.Types.ObjectId,
      ref: DOCUMENT_NAME,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    collection: COLLECTION_NAME,
    timestamps: true,
  }
);

module.exports = model(DOCUMENT_NAME, commentSchema, COLLECTION_NAME);
