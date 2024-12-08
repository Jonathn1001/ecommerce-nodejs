"use strict";

const InventoryService = require("../services/inventory.service");
const { catchAsync } = require("../helpers");
const { SuccessResponse } = require("../utils/SuccessResponse");

class InventoryController {
  // TODO: Add Stock To Inventory
  addStockToInventory = catchAsync(async (req, res) => {
    return new SuccessResponse({
      message: "Add stock to inventory successfully",
      metadata: await InventoryService.addStockToInventory(req.body),
    }).send(res);
  });
}

module.exports = new InventoryController();
