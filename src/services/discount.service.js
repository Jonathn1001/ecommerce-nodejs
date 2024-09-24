"use strict";

// ~ Utils
const { today } = require("../utils/date.utils");
const { BadRequestError, NotFoundError } = require("../utils/AppError");
const { convertToObjectId, countAppearances } = require("../utils");

// ~ Repositories
const {
  createDiscountCode,
  findDiscountByCode,
  getAllDiscountCodesUnselect,
  deleteDiscountCode,
  updateDiscountCode,
} = require("../models/repositories/discount.repo");
const { DISCOUNT_APPLIES_TO, DISCOUNT_TYPES } = require("../constants");
const { getAllProducts } = require("../models/repositories/product.repo");

/**
 * TODO:  Discount Service
 * 1. Generate discount code [Admin|Shop]
 * 2. Get discount amount [User]
 * 3. Get discount codes [User|Shop]
 * 4. Verify discount code [Admin|Shop]
 * 5. Delete discount code [Admin|Shop]
 * 6. Cancel discount code [User]
 */

class DiscountService {
  /**
   * TODO: Create discount code
   * @param {*} payload
   * @returns
   */
  static async createDiscountCode(payload) {
    const { code, start_date, end_date, shop_id, type, value } = payload;
    if (new Date(start_date) > new Date(end_date)) {
      throw new Error("Start date cannot be greater than end date");
    }
    if (today > new Date(end_date)) {
      throw new Error("Discount has already expired");
    }
    if (type === DISCOUNT_TYPES.PERCENTAGE && (value < 1 || value > 100)) {
      throw new Error("Discount percentage value must be between 1 and 100");
    }
    const foundDiscount = await findDiscountByCode(code, shop_id);
    if (foundDiscount && foundDiscount.discount_is_active) {
      throw new BadRequestError("Discount code already exists");
    }
    const newDiscount = await createDiscountCode({
      ...payload,
      code,
      shop_id,
      start_date,
      end_date,
    });
    return newDiscount;
  }
  /**
   * TODO: Get all products available with discount
   * @param {*} payload
   * @returns
   */
  static async getAllProductAvailableDiscount({ code, shop_id, limit, page }) {
    // ? Create index for discount_code
    const foundDiscount = await findDiscountByCode(code, shop_id);

    if (!foundDiscount || !foundDiscount.discount_is_active) {
      throw new NotFoundError("Discount code not found");
    }
    const { discount_products, discount_applies_to } = foundDiscount;
    let products = [],
      query = {
        limit,
        page,
        sort: "ctime",
        select: ["product_name", "product_price"],
      };
    if (discount_applies_to === DISCOUNT_APPLIES_TO.ALL_PRODUCTS) {
      // ? Get all products with discount
      products = await getAllProducts({
        ...query,
        filter: {
          product_shop: convertToObjectId(shop_id),
          isPublished: true,
        },
      });
    }
    if (discount_applies_to === DISCOUNT_APPLIES_TO.SPECIFIC_PRODUCTS) {
      // ? Get specific products with discount
      products = await getAllProducts({
        ...query,
        filter: { _id: { $in: discount_products }, isPublished: true },
      });
    }
    return products;
  }
  /**
   * TODO: Get all discount codes available by shops
   * @param {*} payload
   * @returns
   */
  static async getAllDiscountCodesByShop({ limit, page, shop_id }) {
    const discounts = await getAllDiscountCodesUnselect({
      limit,
      page,
      filter: {
        discount_shop_id: convertToObjectId(shop_id),
        discount_is_active: true,
      },
      unselect: ["__v ", "discount_shop_id"],
    });
    return discounts;
  }

  /**
   * TODO: Get Discount Amount
   * @param {*} payload
   * @returns
   */
  static async getDiscountAmount({ code, shop_id, user_id, products }) {
    const foundDiscount = await findDiscountByCode(code, shop_id);
    if (!foundDiscount || !foundDiscount.discount_is_active) {
      throw new NotFoundError("Discount code not found");
    }
    const {
      discount_type,
      discount_min_order_value,
      discount_max_use,
      discount_max_use_per_user,
      discount_used_count,
      discount_used_users,
      discount_value,
      discount_end_date,
    } = foundDiscount;
    // ? Check if the discount is still valid
    if (discount_max_use <= discount_used_count) {
      throw new Error("Discount code has reached maximum usage");
    }
    // if (today < new Date(discount_start_date)) {
    //   throw new Error("Discount is not yet active");
    // }
    if (today > new Date(discount_end_date)) {
      throw new Error("Discount has expired");
    }
    // ? Check if the order value is greater than the minimum order value
    const orderValue = products.reduce(
      (acc, product) => acc + product.price * product.quantity,
      0
    );
    if (discount_min_order_value > orderValue) {
      throw new Error(
        `Minimum order value is ${discount_min_order_value} to use this discount`
      );
    }
    // ? Check if how many times the discount has been used by the user
    const discountUsedByUser = countAppearances(discount_used_users, user_id);
    if (discount_max_use_per_user <= discountUsedByUser) {
      throw new Error("Discount code has reached maximum usage by this user");
    }
    const amount =
      discount_type === DISCOUNT_TYPES.FIXED_AMOUNT
        ? discount_value
        : (orderValue * discount_value) / 100;
    return {
      subTotal: orderValue,
      discount: amount,
      totalAmount: orderValue - amount,
    };
  }

  /**
   * TODO: Delete a discount
   * @param {*} payload
   * @returns
   */
  static async deleteDiscountCode({ code, shop_id }) {
    const foundDiscount = await findDiscountByCode(code, shop_id);
    if (!foundDiscount) {
      throw new NotFoundError("Discount code not found");
    }
    return await deleteDiscountCode(foundDiscount._id);
  }

  /**
   * TODO: Cancel a discount
   * @param {*} payload
   * @returns
   */
  static async cancelDiscountCode({ code, shop_id, user_id }) {
    const foundDiscount = await findDiscountByCode(code, shop_id);
    if (!foundDiscount) {
      throw new NotFoundError("Discount code not found");
    }
    const { discount_used_users } = foundDiscount;
    const index = discount_used_users.indexOf(user_id);
    if (index === -1) {
      throw new Error("Discount code has not been used by this user");
    }
    discount_used_users.splice(index, 1);
    return await updateDiscountCode(foundDiscount._id, {
      discount_used_users,
      discount_used_count: discount_used_count - 1,
    });
  }
}

module.exports = DiscountService;
