"use strict";

const { catchAsync } = require("../helpers");
const ProductService = require("../services/product.service");
const { SuccessResponse } = require("../utils/SuccessResponse");

class ProductController {
  createProduct = catchAsync(async (req, res) => {
    new SuccessResponse({
      message: "Create product successfully",
      metadata: await ProductService.createProduct(req.body.product_type, {
        ...req.body,
        product_shop: req.user.userId,
      }),
    }).send(res);
  });

  updateProduct = catchAsync(async (req, res) => {
    new SuccessResponse({
      message: "Update product successfully",
      metadata: await ProductService.updateProduct(req.body.product_type, {
        product_id: req.params.product_id,
        payload: req.body,
      }),
    }).send(res);
  });

  /**
   * Get all draft products for shop
   * @param {Number} limit
   * @param {Limit} res
   *
   */
  getAllDraftsForShop = catchAsync(async (req, res) => {
    const drafts = await ProductService.findAllDraftsForShop({
      product_shop: req.user.userId,
      limit: req.query.limit,
      skip: req.query.skip,
    });
    new SuccessResponse({
      message: "Get all draft products successfully",
      metadata: { data: drafts, total: drafts.length },
    }).send(res);
  });

  getAllPublicForShop = catchAsync(async (req, res) => {
    const drafts = await ProductService.findAllPublicProductsForShop({
      product_shop: req.user.userId,
      limit: req.query.limit,
      skip: req.query.skip,
    });
    new SuccessResponse({
      message: "Get all public products successfully",
      metadata: { data: drafts, total: drafts.length },
    }).send(res);
  });

  publishProduct = catchAsync(async (req, res) => {
    const publishedProduct = await ProductService.PublishProductByShop({
      product_shop: req.user.userId,
      product_id: req.params.product_id,
    });
    new SuccessResponse({
      message: "Publish product successfully",
      metadata: { data: publishedProduct, total: publishedProduct.length },
    }).send(res);
  });

  unpublishProduct = catchAsync(async (req, res) => {
    const unpublishedProduct = await ProductService.UnpublishProductByShop({
      product_shop: req.user.userId,
      product_id: req.params.product_id,
    });
    new SuccessResponse({
      message: "Unpublish product successfully",
      metadata: { data: unpublishedProduct, total: unpublishedProduct.length },
    }).send(res);
  });

  searchProductByUser = catchAsync(async (req, res) => {
    const results = await ProductService.searchProductByUser(req.params);
    new SuccessResponse({
      message: "Search product successfully",
      metadata: { data: results, total: results.length },
    }).send(res);
  });

  getAllProducts = catchAsync(async (req, res) => {
    const results = await ProductService.getAllProducts(req.query);
    new SuccessResponse({
      message: "Get all products successfully",
      metadata: { data: results, total: results.length },
    }).send(res);
  });

  getProductDetails = catchAsync(async (req, res) => {
    const details = await ProductService.getProductDetails({
      product_id: req.params.product_id,
    });
    new SuccessResponse({
      message: "Get product details successfully",
      metadata: details,
    }).send(res);
  });
}

module.exports = new ProductController();
