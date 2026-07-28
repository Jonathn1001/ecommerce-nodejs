"use strict";
/**
 * Key functionalities of the Cart Service
 * 1. Add product to cart [User]
 * 2. Reduce product quantity [User]
 * 3. Increase product quantity [User]
 * 4. Get cart [User]
 * 5. Delete Cart
 * 6. Delete product from cart [User]
 */
const {
  findCartByUserId,
  createCart,
  updateProductQuantity,
  deleteProductFromCart,
  getListUserCart,
  findProductInCart,
} = require("../models/repositories/cart.repo");
const { findProductById } = require("../models/repositories/product.repo");

const { NotFoundError } = require("../utils/AppError");

class CartService {
  /**
   * TODO : Add product to cart
   * @param {Object} { user_id, product }
   * @returns {Object} Cart
   */
  static async addToCart({ user_id, product = {} }) {
    const foundCart = await findCartByUserId(user_id);
    if (!foundCart) {
      // ? Create a new cart and add product
      const newCart = await createCart({ user_id, product });
      return newCart;
    }
    const foundProductInCart = await findProductInCart({
      user_id,
      product_id: product.product_id,
    });
    // ? Case where cart exists, but product does not exist
    if (!foundProductInCart) {
      foundCart.cart_products.push(product);
      return await foundCart.save();
    }
    // ? Case where cart exists, and product exists, update quantity
    return await updateProductQuantity({ user_id, product });
  }

  /**
   * TODO : Update products quantity in cart
   * @param {Object} { user_id, shop_order_ids }
   * @returns {Object} Cart
   */
  static async updateProductQuantity({ user_id, shop_order_ids = [] }) {
    const { product_id, quantity, old_quantity } =
      shop_order_ids[0]?.item_products[0];
    // ? Check if product exists
    const foundProduct = await findProductById({ product_id });
    if (!foundProduct) throw new NotFoundError("Product does not exist");
    // ? Case where product exists, update quantity
    if (foundProduct.product_shop.toString() !== shop_order_ids[0].shop_id)
      throw new NotFoundError("Product does not belong in this shop");
    if (quantity === 0) {
      // ? Delete product from cart
      return await deleteProductFromCart({ user_id, product_id });
    }
    return await updateProductQuantity({
      user_id,
      product: {
        product_id,
        quantity: quantity - old_quantity,
      },
    });
  }

  /**
   * TODO: Delete product from cart
   * @param {String} user_id
   * @returns {Object} Cart
   */
  static async deleteProductFromCart({ user_id, product_id }) {
    return await deleteProductFromCart({ user_id, product_id });
  }

  /**
   *  TODO : Get list user cart
   * @param {String} user_id
   * @returns {Object} Cart
   */
  static async getListUserCart({ user_id }) {
    return await getListUserCart({ user_id });
  }
}

module.exports = CartService;
