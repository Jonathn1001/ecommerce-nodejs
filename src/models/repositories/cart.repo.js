"use strict";

const { convertToObjectId } = require("../../utils");
const { CartModel } = require("../cart.model");

const findCartByUserId = async (user_id) => {
  return await CartModel.findOne({ cart_user_id: user_id });
};

const findCartById = async (cart_id) => {
  return await CartModel.findOne({
    _id: convertToObjectId(cart_id),
    cart_state: "active",
  }).lean();
};

const createCart = async ({ user_id, product }) => {
  return await CartModel.create({
    cart_user_id: user_id,
    cart_state: "active",
    cart_products: [product],
  });
};

const findProductInCart = async ({ user_id, product_id }) => {
  return await CartModel.findOne({
    cart_user_id: user_id,
    "cart_products.product_id": product_id,
    cart_state: "active",
  });
};

const updateProductQuantity = async ({ user_id, product }) => {
  const { product_id, quantity } = product;
  const query = {
      cart_user_id: user_id,
      "cart_products.product_id": product_id,
      cart_state: "active",
    },
    update = {
      $inc: {
        "cart_products.$.quantity": quantity,
      },
    },
    options = {
      new: true,
    };
  return await CartModel.findOneAndUpdate(query, update, options);
};

const deleteProductFromCart = async ({ user_id, product_id }) => {
  const query = {
      cart_user_id: user_id,
      cart_state: "active",
    },
    update = {
      $pull: {
        cart_products: {
          product_id,
        },
      },
    },
    options = {
      new: true,
    };
  return await CartModel.updateOne(query, update, options);
};

const getListUserCart = async ({ user_id }) => {
  return await CartModel.findOne({ cart_user_id: user_id }).select().lean();
};

module.exports = {
  findCartByUserId,
  createCart,
  updateProductQuantity,
  deleteProductFromCart,
  getListUserCart,
  findProductInCart,
  findCartById,
};
