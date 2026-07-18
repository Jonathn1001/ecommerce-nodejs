"use strict";

const {
  addStockToInventory,
} = require("../models/repositories/inventory.repo");
const { findProductById } = require("../models/repositories/product.repo");
const { NotFoundError } = require("../utils/AppError");

class InventoryService {
  static async addStockToInventory({
    product_id,
    shop_id,
    stock,
    location = "store",
  }) {
    const product = await findProductById({ product_id });
    if (!product) throw new NotFoundError("Product not found");
    return await addStockToInventory({ product_id, shop_id, stock, location });
  }
}
module.exports = InventoryService;
