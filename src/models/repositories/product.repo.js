"use strict";

const { getSelectData, getUnSelectData } = require("../../utils");
const { BadRequestError } = require("../../utils/AppError");
const { product } = require("../product.model");

const productQuery = async ({ query, limit = 50, skip = 0 }) => {
  return await product
    .find(query)
    .populate("product_shop", "name email -_id")
    .skip(skip)
    .limit(limit)
    .lean();
};

const findAllDraftsForShop = async ({ query, limit = 50, skip = 0 }) => {
  return await productQuery({ query, limit, skip });
};

const publishProductByShop = async ({ product_shop, product_id }) => {
  const foundShop = await product.findOne({
    product_shop: product_shop,
    _id: product_id,
  });
  if (!foundShop) return null;

  foundShop.isDraft = false;
  foundShop.isPublished = true;
  return await foundShop.updateOne(foundShop);
};

const findAllPublicProducts = async ({ query, limit = 50, skip = 0 }) => {
  return await productQuery({ query, limit, skip });
};

const unpublishProductByShop = async ({ product_shop, product_id }) => {
  const foundShop = await product.findOne({
    product_shop: product_shop,
    _id: product_id,
  });
  if (!foundShop) return null;

  foundShop.isDraft = true;
  foundShop.isPublished = false;
  return await foundShop.updateOne(foundShop);
};

const searchProductByUser = async ({ regexSearch }) => {
  return await product
    .find({ isPublished: true, product_name: regexSearch })
    // .find(
    //   {
    //     isPublished: true,
    //     $text: { $search: regexSearch },
    //   },
    //   { score: { $meta: "textScore" } }
    // )
    .lean();
};

const getAllProducts = async ({
  sort,
  limit = 50,
  page = 1,
  filter,
  select = [],
}) => {
  const skip = (page - 1) * limit;
  const sortBy = sort === "ctime" ? { _id: -1 } : { id: 1 };
  const products = await product
    .find(filter)
    .sort(sortBy)
    .skip(skip)
    .limit(limit)
    .select(getSelectData(select))
    .lean();
  return products;
};

const getProductDetails = async ({ product_id, unselect }) => {
  return await product
    .findById(product_id)
    .select(getUnSelectData(unselect))
    .lean();
};

const updateProductById = async ({ product_id, payload, model }) => {
  const updated = model.findByIdAndUpdate(product_id, payload, { new: true });
  return updated;
};

const findProductById = async ({ product_id }) => {
  return await product.findById(product_id).lean();
};

const getValidCheckoutProducts = async (products = []) => {
  return await Promise.all(
    products.map(async (product) => {
      const foundProduct = await findProductById({
        product_id: product.product_id,
      });
      if (!foundProduct) return null;
      if (foundProduct.product_quantity < product.quantity)
        throw new BadRequestError("Product quantity is not enough");
      return {
        price: foundProduct.product_price,
        quantity: product.quantity,
        product_id: product.product_id,
      };
    })
  );
};

module.exports = {
  findAllDraftsForShop,
  publishProductByShop,
  findAllPublicProducts,
  unpublishProductByShop,
  searchProductByUser,
  getAllProducts,
  getProductDetails,
  updateProductById,
  findProductById,
  getValidCheckoutProducts,
};
