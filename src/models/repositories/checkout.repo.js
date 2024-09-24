"use strict";

const { CheckoutModel } = require("../checkout.model");

const findCheckoutByUserId = async (user_id) => {
  return await CheckoutModel.findOne({ checkout_user_id: user_id });
};
