"use strict";

const CartService = require("../services/cart.service");
const { catchAsync } = require("../helpers");
const { SuccessResponse } = require("../utils/SuccessResponse");

class CartController {
  // TODO: Add product to cart
  addToCart = catchAsync(async (req, res) => {
    return new SuccessResponse({
      message: "Product added to cart successfully",
      metadata: await CartService.addToCart(req.body),
    }).send(res);
  });
  // TODO: Update products quantity in cart
  updateProductQuantity = catchAsync(async (req, res) => {
    return new SuccessResponse({
      message: "Product quantity updated successfully",
      metadata: await CartService.updateProductQuantity(req.body),
    }).send(res);
  });
  // TODO: Delete product from cart
  deleteProductFromCart = catchAsync(async (req, res) => {
    return new SuccessResponse({
      message: "Product deleted from cart successfully",
      metadata: await CartService.deleteProductFromCart(req.body),
    }).send(res);
  });
  // TODO: Get user cart
  getListUserCart = catchAsync(async (req, res) => {
    return new SuccessResponse({
      message: "List cart by user successfully",
      metadata: await CartService.getListUserCart(req.params),
    }).send(res);
  });
}

module.exports = new CartController();
