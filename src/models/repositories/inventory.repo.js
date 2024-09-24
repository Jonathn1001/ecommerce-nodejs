"use strict";

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

module.exports = {
  insertInventory,
};
