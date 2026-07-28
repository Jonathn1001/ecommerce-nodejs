"use strict";

const express = require("express");
const checkoutController = require("../../controller/checkout.controller");
const { apiKey, authentication } = require("../../auth/checkAuth");
const router = express.Router();

router.use(apiKey);
router.use(authentication);

router.post("/preview", checkoutController.checkoutPreview);

module.exports = router;
