"use strict";

const { convertToObjectId } = require("../../utils");
const inventoryModel = require("../inventory.model");

const insertInventory = async ({
  product_id,
  shop_id,
  stock,
  location = "store",
}) => {
  return await inventoryModel.create({
    invent_product_id: product_id,
    invent_shop_id: shop_id,
    invent_stock: stock,
    invent_location: location,
  });
};

const reserveInventory = async ({ product_id, cart_id, quantity }) => {
  const query = {
      invent_product_id: convertToObjectId(product_id),
      invent_stock: { $gte: quantity },
    },
    updateSet = {
      $inc: {
        invent_stock: -quantity,
      },
      $push: {
        invent_reservations: {
          quantity,
          cart_id,
          createdAt: new Date(),
        },
      },
    },
    options = {
      upsert: true,
      new: true,
    };
  return await inventoryModel.updateOne(query, updateSet, options);
};

const addStockToInventory = async ({
  shop_id,
  product_id,
  location,
  stock,
}) => {
  const query = { invent_shop_id: shop_id, invent_product_id: product_id },
    updateSet = {
      $inc: {
        invent_stock: stock,
      },
      $set: {
        invent_location: location,
      },
    },
    options = {
      upsert: true,
      new: true,
    };
  return await inventoryModel.updateOne(query, updateSet, options);
};

// ? Compensating action for reserveInventory: give the stock back and drop
// ? this cart's reservation. Used to roll back a partial/failed checkout.
const releaseInventory = async ({ product_id, cart_id, quantity }) => {
  const query = { invent_product_id: convertToObjectId(product_id) };
  const updateSet = {
    $inc: { invent_stock: quantity },
    $pull: { invent_reservations: { cart_id } },
  };
  return await inventoryModel.updateOne(query, updateSet);
};

module.exports = {
  insertInventory,
  reserveInventory,
  addStockToInventory,
  releaseInventory,
};
