"use strict";

const { Schema, model } = require("mongoose"); // Erase if already required
const DOCUMENT_NAME = "Role";
const COLLECTION_NAME = "Roles";

// Declare the Schema of the Mongo model
var roleSchema = new Schema(
  {
    rol_name: {
      type: String,
      required: true,
      enum: ["user", "shop", "admin"],
    },
    rol_slug: {
      type: String,
      default: true,
    },
    rol_status: {
      type: String,
      default: "active",
      enum: ["pending", "active", "blocked"],
    },
    rol_description: {
      type: String,
      default: "",
    },
    rol_grants: [
      {
        resource: {
          type: Schema.Types.ObjectId,
          ref: "Resource",
          required: true,
        },
        actions: {
          type: [String],
          required: true,
          enum: ["create", "read", "update", "delete"],
        },
        attributes: {
          type: [String],
          default: ["*"],
        },
      },
    ],
  },
  {
    timestamps: true,
    collection: COLLECTION_NAME,
  }
);

//Export the model
module.exports = model(DOCUMENT_NAME, roleSchema);
