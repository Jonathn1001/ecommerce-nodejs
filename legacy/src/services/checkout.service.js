"use strict";

const {
  findCartById,
  removeProductsFromCart,
} = require("../models/repositories/cart.repo");
const { createOrder } = require("../models/repositories/order.repo");
const { releaseInventory } = require("../models/repositories/inventory.repo");
const {
  getValidCheckoutProducts,
} = require("../models/repositories/product.repo");
const { NotFoundError, BadRequestError } = require("../utils/AppError");
const { getDiscountAmount } = require("./discount.service");
const { acquireLock, releaseLock } = require("./redis.service");

// ? Best-effort compensation: allSettled so one failed release does not abort
// ? the rest or mask the original error the caller is about to rethrow.
const rollbackReservations = async (reserved, cart_id) => {
  await Promise.allSettled(
    reserved.map((p) => releaseInventory({ ...p, cart_id }))
  );
};

class CheckoutService {
  // ? This function is used to preview the checkout order
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
  // ? This function is used to place the order
  static async placeOrder({
    cart_id,
    user_id,
    shop_order_ids,
    user_address = {},
    user_payment = {},
  }) {
    const { checkout_order, shop_order_ids_new } = await this.checkoutPreview({
      cart_id,
      user_id,
      shop_order_ids,
    });
    // ? Reserve every product atomically. Track what we reserve so a later
    // ? failure can roll it back instead of leaving stock silently held.
    const products = shop_order_ids_new.flatMap(
      (shop_order) => shop_order.item_products
    );
    const reserved = [];
    for (const product of products) {
      const { product_id, quantity } = product;
      const keyLock = await acquireLock(product_id, quantity, cart_id);
      if (!keyLock) {
        // ? Unavailable product: compensate everything reserved so far
        await rollbackReservations(reserved, cart_id);
        throw new BadRequestError(
          "Some products are not available, Please back to cart and try again"
        );
      }
      reserved.push({ product_id, quantity });
      // ? Reservation is durable in MongoDB; free the Redis mutex now
      await releaseLock(keyLock);
    }
    // ? All products reserved: create the order, rolling back on failure
    let newOrder;
    try {
      newOrder = await createOrder({
        order_user_id: user_id,
        order_checkout: checkout_order,
        order_shipping: user_address,
        order_payment: user_payment,
        order_products: products,
      });
    } catch (error) {
      await rollbackReservations(reserved, cart_id);
      throw error;
    }
    // ? Order placed: remove the ordered products from the cart (by cart_id,
    // ? the checkout identity, in a single write)
    if (newOrder) {
      await removeProductsFromCart({
        cart_id,
        product_ids: products.map((product) => product.product_id),
      });
    }
    return newOrder;
  }
  // ? This function is used to get all orders by user
  static async getAllOrdersByUser({ user_id }) {}
  // ? This function is used to get the order details by user
  static async getOrderDetailsByUser({ user_id }) {}
  // ? This function is used to update order status by Shop||Admin
  static async updateOrderStatus({ order_id, status }) {}
}

module.exports = CheckoutService;
