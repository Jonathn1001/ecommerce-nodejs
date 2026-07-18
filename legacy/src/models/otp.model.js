// Desc: OTP model for storing OTP tokens in the database
"use strict";

const { model, Schema } = require("mongoose");

const DOCUMENT_NAME = "otp_log";
const COLLECTION_NAME = "otp_logs";

const otpSchema = new Schema(
  {
    otp_token: {
      type: String,
      required: true,
    },
    otp_email: {
      type: String,
      required: true,
    },
    otp_status: {
      type: String,
      default: "pending",
      enum: ["pending", "verified", "blocked"],
    },
    expireAt: {
      type: Date,
      default: Date.now,
      index: { expires: "60s" }, // ? expire in 60 seconds
    },
  },
  {
    timestamps: true,
    collection: COLLECTION_NAME,
  }
);

module.exports = model(DOCUMENT_NAME, otpSchema, COLLECTION_NAME);
