"use strict";

const CheckoutService = require("../services/checkout.service");
const { catchAsync } = require("../helpers");
const { SuccessResponse } = require("../utils/SuccessResponse");

class CheckoutController {
  // TODO:Checkout Review
  checkoutPreview = catchAsync(async (req, res) => {
    return new SuccessResponse({
      message: "Checkout preview successfully",
      metadata: await CheckoutService.checkoutPreview(req.body),
    }).send(res);
  });
}

module.exports = new CheckoutController();
