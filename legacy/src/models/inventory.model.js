"use strict";

// ? Define the inventory model
const { model, Schema } = require("mongoose");

const DOCUMENT_NAME = "Inventory";
const COLLECTION_NAME = "Inventories";

const inventorySchema = new Schema(
  {
    invent_product_id: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    invent_stock: {
      type: Number,
      required: true,
    },
    invent_location: {
      type: String,
      default: "Main Store",
    },
    invent_shop_id: {
      type: Schema.Types.ObjectId,
      ref: "Shop",
      required: true,
    },
    invent_reservations: {
      type: Array,
      default: [],
    },
    /**
     * ? The `invent_reservations` field is an array of objects that will contain the following fields:
     * ? - `reserv_id` (String): The reservation ID.
     * ? - `reserv_qty` (Number): The quantity of the product that is reserved.
     * ? - createdAt (Date): The date when the reservation was created.
     */
  },
  {
    timestamps: true,
    collection: COLLECTION_NAME,
  }
);

module.exports = model(DOCUMENT_NAME, inventorySchema);
