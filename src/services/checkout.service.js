"use strict";

const { findCartById } = require("../models/repositories/cart.repo");
const {
  getValidCheckoutProducts,
} = require("../models/repositories/product.repo");
const { NotFoundError } = require("../utils/AppError");
const { getDiscountAmount } = require("./discount.service");

class CheckoutService {
  static async checkoutPreview({ cart_id, user_id, shop_order_ids }) {
    const foundCart = await findCartById(cart_id);
    if (!foundCart) throw new NotFoundError("Cart does not exist");
    // ?
    const checkout_order = {
      totalPrice: 0,
      shippingFee: 0,
      totalDiscount: 0,
      totalCheckoutPrice: 0,
    };
    const shop_order_ids_new = await Promise.all(
      shop_order_ids.map(async (shop_order_id) => {
        const { shop_id, shop_discounts, item_products } = shop_order_id;
        const validCheckoutProducts = await getValidCheckoutProducts(
          item_products
        );
        // ? Total price of products in cart
        const checkoutPrice = validCheckoutProducts.reduce((acc, product) => {
          return acc + product.quantity * product.price;
        }, 0);
        checkout_order.totalPrice += checkoutPrice;
        // ? Initialize checkout item
        const checkoutItem = {
          shop_id,
          shop_discounts,
          rawPrice: checkoutPrice, // ? default price
          appliedDiscountPrice: checkoutPrice, // ? Price before discount
          item_products: validCheckoutProducts,
        };
        // ? Calculate discount
        if (shop_discounts.length > 0) {
          // ? Assume we only have one discount code
          const { discount, totalAmount } = await getDiscountAmount({
            code: shop_discounts[0].discount_code,
            shop_id,
            user_id,
            products: validCheckoutProducts,
          });
          checkout_order.totalDiscount += discount;
          if (discount > 0) {
            // ? Price after discount
            checkoutItem.appliedDiscountPrice = totalAmount;
          }
        }
        // ? Add to total cart price
        checkout_order.totalCheckoutPrice += checkoutItem.appliedDiscountPrice;
        return checkoutItem;
      })
    );
    return { shop_order_ids, shop_order_ids_new, checkout_order };
  }
}

module.exports = CheckoutService;
