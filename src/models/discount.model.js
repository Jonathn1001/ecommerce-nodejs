"use strict";

const { Schema, model } = require("mongoose"); // Erase if already required

const DOCUMENT_NAME = "Discount";
const COLLECTION_NAME = "discounts";

const { DISCOUNT_APPLIES_TO, DISCOUNT_TYPES } = require("../constants");
const { convertToArray } = require("../utils");

const discountSchema = new Schema(
  {
    discount_name: {
      type: String,
      required: true,
    },
    discount_description: {
      type: String,
      required: true,
    },
    discount_type: {
      type: String,
      required: true,
      default: "fixed_amount",
      enum: convertToArray(DISCOUNT_TYPES),
    },
    discount_value: {
      type: Number,
      required: true,
    },
    discount_code: {
      type: String,
      required: true,
    },
    discount_start_date: {
      type: Date,
      required: true,
    },
    discount_end_date: {
      type: Date,
      required: true,
    },
    discount_max_use: {
      // ? maximum number of times the discount can be used
      type: Number,
      required: true,
    },
    discount_used_count: {
      // ? number of times the discount has been used
      type: Number,
      required: true,
      default: 0,
    },
    discount_max_use_per_user: {
      // ? maximum number of times the discount can be used per user
      type: Number,
      required: true,
    },
    discount_used_users: {
      // ? array of users who have used the discount
      type: Array,
      default: [],
    },
    discount_min_order_value: {
      // ? minimum value of the order required to use the discount
      type: Number,
      required: true,
    },
    discount_shop_id: {
      // ? shop to which the discount belongs
      type: Schema.Types.ObjectId,
      ref: "Shop",
      required: true,
    },
    discount_is_active: {
      // ? whether the discount is active or not
      type: Boolean,
      default: true,
    },
    discount_applies_to: {
      // ? whether the discount applies to all products or specific products
      type: String,
      required: true,
      enum: convertToArray(DISCOUNT_APPLIES_TO),
    },
    discount_products: {
      // ? array of product IDs to which the discount applies
      type: Array,
      default: [],
    },
  },
  {
    timestamps: true,
    collection: COLLECTION_NAME,
  }
);

module.exports = model(DOCUMENT_NAME, discountSchema);
