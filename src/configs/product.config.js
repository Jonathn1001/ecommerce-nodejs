const { updateProductById } = require("../models/repositories/product.repo");
const {
  product,
  clothing,
  electronics,
  furniture,
  motorbike,
} = require("./../models/product.model");

// ? define product class
class Product {
  constructor({
    product_name,
    product_thumb,
    product_description,
    product_price,
    product_quantity,
    product_type,
    product_shop,
    product_attributes,
  }) {
    this.product_name = product_name;
    this.product_thumb = product_thumb;
    this.product_description = product_description;
    this.product_price = product_price;
    this.product_quantity = product_quantity;
    this.product_type = product_type;
    this.product_shop = product_shop;
    this.product_attributes = product_attributes;
  }

  async createProduct(product_id) {
    return await product.create({ ...this, _id: product_id });
  }

  // ? Update product
  async updateProduct({ product_id, payload }) {
    return await updateProductById({ product_id, payload, model: product });
  }
}

class Clothing extends Product {
  async createProduct() {
    const newClothing = await clothing.create({
      ...this.product_attributes,
      product_shop: this.product_shop,
    });
    if (!newClothing) throw BadRequestError("Create new clothing error");
    const newProduct = await super.createProduct(newClothing._id);
    if (!newProduct) throw BadRequestError("Create new product error");
    return newProduct;
  }

  async updateProduct({ product_id, payload }) {
    await updateProductById({
      product_id,
      payload: { ...payload.product_attributes },
      model: clothing,
    });
    return await super.updateProduct({ product_id, payload });
  }
}

class Electronics extends Product {
  async createProduct() {
    const newElectronics = await electronics.create({
      ...this.product_attributes,
      product_shop: this.product_shop,
    });
    if (!newElectronics) throw BadRequestError("Create new clothing error");
    const newProduct = await super.createProduct(newElectronics._id);
    if (!newProduct) throw BadRequestError("Create new product error");
    return newProduct;
  }

  async updateProduct({ product_id, payload }) {
    await updateProductById({
      product_id,
      payload: { ...payload.product_attributes },
      model: electronics,
    });
    return await super.updateProduct({
      product_id,
      payload,
    });
  }
}

class Furniture extends Product {
  async createProduct() {
    // ? implement createProduct method for Furniture
    const newFurniture = await furniture.create({
      ...this.product_attributes,
      product_shop: this.product_shop,
    });
    if (!newFurniture) throw BadRequestError("Create new furniture error");
    const newProduct = await super.createProduct(newFurniture._id);
    if (!newProduct) throw BadRequestError("Create new product error");
    return newProduct;
  }

  async updateProduct({ product_id, payload }) {
    await updateProductById({
      product_id,
      payload: { ...payload.product_attributes },
      model: furniture,
    });
    return await super.updateProduct({ product_id, payload });
  }
}

class Motorbike extends Product {
  async createProduct() {
    const newMotorBike = await motorbike.create({
      ...this.product_attributes,
      product_shop: this.product_shop,
    });
    if (!newMotorBike) throw BadRequestError("Create new motorbike error");
    const newProduct = await super.createProduct(newMotorBike._id);
    if (!newProduct) throw BadRequestError("Create new product error");
    return newProduct;
  }

  async updateProduct({ product_id, payload }) {
    await updateProductById({
      product_id,
      payload: { ...payload.product_attributes },
      model: motorbike,
    });
    return await super.updateProduct({ product_id, payload });
  }
}

module.exports = {
  Clothing,
  Electronics,
  Furniture,
  Motorbike,
};
