"use strict";

const { Schema, model } = require("mongoose");
const slugify = require("slugify");
const DOCUMENT_NAME = "Product";
const COLLECTION_NAME = "Products";

var ProductSchema = new Schema(
  {
    product_name: {
      type: String,
      required: true,
    },
    product_thumb: {
      type: String,
      required: true,
    },
    product_description: String,
    product_slug: String, // unique
    product_price: {
      type: Number,
      required: true,
    },
    product_quantity: {
      type: Number,
      required: true,
    },
    product_type: {
      type: String,
      required: true,
      enum: ["Electronics", "Clothing", "Furniture", "Motorbike"],
    },
    product_shop: { type: Schema.Types.ObjectId, ref: "Shop", required: true },
    product_attributes: { type: Schema.Types.Mixed, required: true },
    product_rating: {
      type: Number,
      default: 1.0,
      min: [1, "Rating must be at least 1.0"],
      max: [5, "Rating must be at most 5.0"],
      set: (val) => Math.round(val * 10) / 10,
    },
    product_variations: {
      type: Array,
      default: [],
    },
    isDraft: {
      type: Boolean,
      default: true,
      index: true,
      select: false,
    },
    isPublished: {
      type: Boolean,
      default: false,
      index: true,
      select: false,
    },
  },
  {
    timestamps: true,
    collection: COLLECTION_NAME,
  }
);

// ? Document middleware: run before .save() and .create() --- (webhook)
ProductSchema.pre("save", function (next) {
  this.product_slug = slugify(this.product_name, { lower: true });
  next();
});

// ? Create indexes for faster search
// ProductSchema.index({ product_name: "text", product_description: "text" });

// define the product type = clothing
const ClothingSchema = new Schema(
  {
    brand: { type: String, required: true },
    size: String,
    material: String,
    color: String,
    product_shop: { type: Schema.Types.ObjectId, ref: "Shop" },
  },
  {
    collection: "Clothes",
    timestamps: true,
  }
);

// define the product type = electronics
const ElectronicsSchema = new Schema(
  {
    manufacturer: { type: String, required: true },
    model: String,
    color: String,
    product_shop: { type: Schema.Types.ObjectId, ref: "Shop" },
  },
  {
    collection: "Electronics",
    timestamps: true,
  }
);

// define the product type = furniture
const FurnitureSchema = new Schema(
  {
    brand: { type: String, required: true },
    size: String,
    material: Number,
    product_shop: { type: Schema.Types.ObjectId, ref: "Shop" },
  },
  {
    collection: "Furniture",
    timestamps: true,
  }
);

// define the product type = motorbike
const MotorbikeSchema = new Schema(
  {
    manufacturer: { type: String, required: true },
    model: String,
    color: String,
    product_shop: { type: Schema.Types.ObjectId, ref: "Shop" },
  },
  {
    collection: "Motorbike",
    timestamps: true,
  }
);

module.exports = {
  product: model(DOCUMENT_NAME, ProductSchema),
  electronics: model("Electronics", ElectronicsSchema),
  clothing: model("Clothing", ClothingSchema),
  furniture: model("Furniture", FurnitureSchema),
  motorbike: model("Motorbike", MotorbikeSchema),
};
