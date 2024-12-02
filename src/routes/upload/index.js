"use strict";

const express = require("express");
const uploadController = require("../../controller/upload.controller");
const { apiKey, authentication } = require("../../auth/checkAuth");
const { uploadDisk } = require("../../configs/multer.config");
const router = express.Router();

router.use(apiKey);
router.use(authentication);

router.post("/image", uploadController.uploadImage);
router.post(
  "/product/thumbnail",
  uploadDisk.single("image"),
  uploadController.uploadFromLocal
);
router.post(
  "/multiple",
  uploadDisk.array("images", 5),
  uploadController.uploadMultipleImagesFromLocal
);

module.exports = router;
