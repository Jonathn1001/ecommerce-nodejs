"use strict";

const DiscountService = require("../services/discount.service");
const { catchAsync } = require("../helpers");
const { SuccessResponse } = require("../utils/SuccessResponse");

class DiscountController {
  createDiscountCode = catchAsync(async (req, res) => {
    const discount = await DiscountService.createDiscountCode(req.body);
    return new SuccessResponse({
      message: "Discount created successfully",
      metadata: discount,
    }).send(res);
  });

  getAllDiscountCodesByShop = catchAsync(async (req, res) => {
    const discounts = await DiscountService.getAllDiscountCodesByShop(
      req.query
    );
    return new SuccessResponse({
      message: "Get all discount codes by shop successfully",
      metadata: { total: discounts.length, data: discounts },
    }).send(res);
  });

  getAllProductsAvailableDiscount = catchAsync(async (req, res) => {
    const products = await DiscountService.getAllProductAvailableDiscount(
      req.query
    );
    return new SuccessResponse({
      message: "Get Products Available With Discount Code successfully",
      metadata: { total: products.length, data: products },
    }).send(res);
  });

  getDiscountAmount = catchAsync(async (req, res) => {
    const discountAmount = await DiscountService.getDiscountAmount(req.body);
    return new SuccessResponse({
      message: "Get Discount Amount successfully",
      metadata: discountAmount,
    }).send(res);
  });

  deleteDiscountCode = catchAsync(async (req, res) => {
    await DiscountService.deleteDiscountCode({
      code: req.params.code,
      shop_id: req.query.shop_id,
    });
    return new SuccessResponse({
      message: "Discount deleted successfully",
    }).send(res);
  });

  cancelDiscountCode = catchAsync(async (req, res) => {
    await DiscountService.cancelDiscountCode({
      code: req.params.code,
      shop_id: req.query.shop_id,
      user_id: req.query.user_id,
    });
    return new SuccessResponse({
      message: "Discount canceled successfully",
    }).send(res);
  });
}

module.exports = new DiscountController();
