"use strict";

const express = require("express");
const notificationController = require("../../controller/notification.controller");
const { apiKey, authentication } = require("../../auth/checkAuth");
const router = express.Router();

router.use(apiKey);
router.use(authentication);

router.get("/", notificationController.getNotificationsByUser);

module.exports = router;
