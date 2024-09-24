"use strict";

const express = require("express");
const discountController = require("../../controller/discount.controller");
const { apiKey, authentication } = require("../../auth/checkAuth");
const router = express.Router();

router.use(apiKey);
router.use(authentication);
router.post("/create", discountController.createDiscountCode);
router.get("/all", discountController.getAllDiscountCodesByShop);
router.get("/amount", discountController.getDiscountAmount);
router.get("/products", discountController.getAllProductsAvailableDiscount);
router.delete("/delete/:code", discountController.deleteDiscountCode);
router.put("/cancel/:code", discountController.cancelDiscountCode);

module.exports = router;
