"use strict";

const express = require("express");
const productController = require("../../controller/product.controller");
const { apiKey, authentication } = require("../../auth/checkAuth");
const router = express.Router();

router.use(apiKey);
router.use(authentication);
router.post("/create", productController.createProduct);
router.patch("/update/:product_id", productController.updateProduct);
router.put("/publish/:product_id", productController.publishProduct);
router.put("/unpublish/:product_id", productController.unpublishProduct);

router.get("/search/:keyword", productController.searchProductByUser);
router.get("/drafts/all", productController.getAllDraftsForShop);
router.get("/public/all", productController.getAllPublicForShop);
router.get("/all", productController.getAllProducts);
router.get("/:product_id/details", productController.getProductDetails);

module.exports = router;
