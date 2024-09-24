"use strict";

// Define a Cart Schema
const { model, Schema } = require("mongoose");

const DOCUMENT_NAME = "Cart";
const COLLECTION_NAME = "carts";

const cartSchema = new Schema(
  {
    cart_user_id: { type: Number, required: true },
    cart_state: {
      type: String,
      required: true,
      enum: ["active", "completed", "cancelled", "pending"],
      default: "active",
    },
    cart_products: [
      {
        product_id: {
          type: Schema.Types.ObjectId,
          ref: "Product",
          required: true,
        },
        quantity: { type: Number, required: true },
      },
    ],
    cart_count_products: { type: Number, default: 0 },
  },
  {
    collection: COLLECTION_NAME,
    timestamps: {
      createdAt: "created_at",
      updatedAt: "modified_at",
    },
  }
);

module.exports = {
  CartModel: model(DOCUMENT_NAME, cartSchema, COLLECTION_NAME),
  DOCUMENT_NAME,
  COLLECTION_NAME,
};
