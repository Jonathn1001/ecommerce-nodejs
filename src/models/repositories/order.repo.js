"use strict";

const { OrderModel } = require("../order.model");

const createOrder = async (order) => {
  return await OrderModel.create(order);
};

module.exports = { createOrder };
