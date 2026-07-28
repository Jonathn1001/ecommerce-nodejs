"use strict";

const ProductClasses = require("./../configs/product.config");
const { BadRequestError } = require("./../utils/AppError");
const {
  findAllDraftsForShop,
  publishProductByShop,
  findAllPublicProducts,
  unpublishProductByShop,
  searchProductByUser,
  getAllProducts,
  getProductDetails,
} = require("./../models/repositories/product.repo");
const { insertInventory } = require("./../models/repositories/inventory.repo");
const { pushNotification } = require("./notification.service");
const { NOTIFICATION_TYPES } = require("../constants");

// ? define factory class to create product
class ProductFactory {
  // ? define product registry as key-class
  static productRegistry = {};

  // ? Register product
  static registerProduct(productType, productClass) {
    this.productRegistry[productType] = productClass;
  }

  // ? Create product
  static async createProduct(productType, productData) {
    const ProductClass = this.productRegistry[productType];
    if (!productType)
      throw new BadRequestError(`Invalid product type: ${productType}`);
    const newProduct = await new ProductClass(productData).createProduct();
    if (newProduct) {
      // add product to inventory collection
      await insertInventory({
        product_id: newProduct._id,
        shop_id: newProduct.product_shop,
        stock: newProduct.product_quantity,
      });
      pushNotification({
        type: NOTIFICATION_TYPES.PROMOTION_CREATED,
        sender: newProduct.product_shop,
        receiver: newProduct.product_shop,
        options: {
          product_name: newProduct.product_name,
        },
      })
        .then((notification) => {
          console.log("Notification", notification);
        })
        .catch((err) => {
          console.log("Error in creating notification", err);
        });
    }
    return newProduct;
  }

  // ? Update product
  static async updateProduct(productType, { product_id, payload }) {
    const ProductClass = this.productRegistry[productType];
    if (!productType)
      throw new BadRequestError(`Invalid product type: ${productType}`);
    return new ProductClass(payload).updateProduct({ product_id, payload });
  }

  // ? Get all drafts for shop
  static async findAllDraftsForShop({ product_shop, limit = 50, skip = 0 }) {
    const query = { product_shop, isDraft: true };
    return await findAllDraftsForShop({ query, limit, skip });
  }

  // ? Publish product by shop
  static async PublishProductByShop({ product_shop, product_id }) {
    return await publishProductByShop({ product_shop, product_id });
  }

  // ? Unpublish product by shop
  static async UnpublishProductByShop({ product_shop, product_id }) {
    return await unpublishProductByShop({ product_shop, product_id });
  }

  // ? Get all public products for shop
  static async findAllPublicProductsForShop({
    product_shop,
    limit = 50,
    skip = 0,
  }) {
    const query = { product_shop, isPublished: true };
    return await findAllPublicProducts({ query, limit, skip });
  }

  // ? Search product
  static async searchProductByUser({ keyword }) {
    console.log("keyword", keyword);
    const regexSearch = new RegExp(keyword, "i");
    const results = await searchProductByUser({
      regexSearch,
    });
    return results;
  }

  // ? Get all products
  static async getAllProducts({
    sort = "ctime",
    limit = 50,
    page = 1,
    filter = { isPublished: true },
  }) {
    return await getAllProducts({
      sort,
      limit,
      page,
      filter,
      select: ["product_name", "product_price", "product_thumb"],
    });
  }

  // ? Get product details
  static async getProductDetails({ product_id }) {
    return await getProductDetails({ product_id, unselect: ["__v"] });
  }
}

Object.keys(ProductClasses).forEach((key) => {
  ProductFactory.registerProduct(key, ProductClasses[key]);
});
// console.log("ProductFactory.productRegistry", ProductFactory.productRegistry);

module.exports = ProductFactory;
