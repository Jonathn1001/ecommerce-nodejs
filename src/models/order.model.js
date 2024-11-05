"use strict";

// Define a Order Schema
const { model, Schema } = require("mongoose");
const { ORDER_STATUSES } = require("../constants");
const { convertToArray } = require("../utils");

const DOCUMENT_NAME = "Order";
const COLLECTION_NAME = "Orders";

const orderSchema = new Schema(
  {
    order_user_id: { type: Number, required: true },
    order_checkout: { type: Object, default: {} },
    // ? This will contain the checkout details: checkout_order field in checkout service
    order_shipping: { type: Object, default: {} },
    // ? This will contain the shipping details: { street, city, state, country, postal_code }
    order_payment: { type: Object, default: {} },
    // ? This will contain the payment details: { payment_method, payment_status }
    order_products: [
      {
        product_id: {
          type: Schema.Types.ObjectId,
          ref: "Product",
          required: true,
        },
        quantity: { type: Number, required: true },
      },
    ],
    //? This will contain the products in the order: shop_order_ids_new field in checkout service
    order_tracking_number: { type: String, default: "#xxxddmmyyyy" },
    order_status: {
      type: String,
      enum: convertToArray(ORDER_STATUSES),
      default: "pending",
    },
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
  OrderModel: model(DOCUMENT_NAME, orderSchema, COLLECTION_NAME),
  DOCUMENT_NAME,
  COLLECTION_NAME,
};
