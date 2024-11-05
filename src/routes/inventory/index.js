"use strict";

const express = require("express");
const inventoryController = require("../../controller/inventory.controller");
const { apiKey, authentication } = require("../../auth/checkAuth");
const router = express.Router();

router.use(apiKey);
router.use(authentication);

router.post("/add/stock", inventoryController.addStockToInventory);

module.exports = router;
