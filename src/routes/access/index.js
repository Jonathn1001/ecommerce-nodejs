"use strict";

const express = require("express");
const router = express.Router();
const accessController = require("../../controller/access.controller");
const {
  apiKey,
  permissions,
  authentication,
} = require("../../auth//checkAuth");

router.use(apiKey);
router.post("/sign-up", permissions("0000"), accessController.signUp);
router.post("/login", accessController.login);

router.use(authentication);
router.post("/logout", accessController.logout);
router.post("/refresh-token", accessController.handleRefreshToken);

module.exports = router;
