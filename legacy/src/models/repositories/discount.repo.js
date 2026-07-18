"use strict";

// ~ Model
const DiscountModel = require("../discount.model");

// ~ Utils
const { convertToObjectId, getUnSelectData } = require("../../utils");
const { DISCOUNT_APPLIES_TO } = require("../../constants");

const findDiscountByCode = async (code, shop_id) => {
  return await DiscountModel.findOne({
    discount_code: code,
    discount_shop_id: convertToObjectId(shop_id),
  }).lean();
};

const createDiscountCode = async (payload) => {
  const {
    start_date,
    end_date,
    shop_id,
    name,
    type,
    code,
    description,
    applies_to,
    value,
    max_use,
    max_use_per_user,
    used_count,
    used_users,
    min_order_value,
    is_active,
    product_ids,
  } = payload;
  return await DiscountModel.create({
    discount_name: name,
    discount_description: description,
    discount_type: type,
    discount_value: value,
    discount_code: code,
    discount_start_date: new Date(start_date),
    discount_end_date: new Date(end_date),
    discount_max_use: max_use,
    discount_max_use_per_user: max_use_per_user,
    discount_used_count: used_count,
    discount_used_users: used_users,
    discount_min_order_value: min_order_value,
    discount_shop_id: convertToObjectId(shop_id),
    discount_is_active: is_active,
    discount_applies_to: applies_to,
    discount_products:
      applies_to === DISCOUNT_APPLIES_TO.ALL_PRODUCTS ? [] : product_ids,
  });
};

const getAllDiscountCodesUnselect = async ({
  limit = 50,
  page = 1,
  sort = "ctime",
  filter = {},
  unselect = [],
}) => {
  const skip = (page - 1) * limit;
  const sortBy = sort === "ctime" ? { _id: -1 } : { id: 1 };
  console.log(getUnSelectData(unselect));
  const discounts = DiscountModel.find(filter)
    .sort(sortBy)
    .skip(skip)
    .limit(limit)
    .select(getUnSelectData(unselect))
    .lean();
  return discounts;
};

const deleteDiscountCode = async (_id) => {
  return await DiscountModel.deleteOne({ _id: convertToObjectId(_id) });
};

const updateDiscountCode = async (_id, payload) => {
  return await DiscountModel.updateOne(
    { _id: convertToObjectId(_id) },
    { $set: { ...payload } }
  );
};

module.exports = {
  findDiscountByCode,
  createDiscountCode,
  getAllDiscountCodesUnselect,
  deleteDiscountCode,
  updateDiscountCode,
};
