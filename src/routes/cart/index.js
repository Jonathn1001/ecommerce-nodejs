"use strict";

const express = require("express");
const cartController = require("../../controller/cart.controller");
const { apiKey, authentication } = require("../../auth/checkAuth");
const router = express.Router();

router.use(apiKey);
router.use(authentication);

router.post("/add", cartController.addToCart);
router.get("/list/:user_id", cartController.getListUserCart);
router.put("/update", cartController.updateProductQuantity);
router.delete("/delete/product", cartController.deleteProductFromCart);

module.exports = router;
