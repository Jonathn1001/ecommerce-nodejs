"use strict";

const express = require("express");
const uploadController = require("../../controller/upload.controller");
const { apiKey, authentication } = require("../../auth/checkAuth");
const { uploadDisk, uploadMemory } = require("../../configs/multer.config");
const router = express.Router();

router.use(apiKey);
router.use(authentication);

// ? Upload to Cloudinary
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

// ? Upload to S3
router.post(
  "/bucket/image",
  uploadMemory.single("image"),
  uploadController.uploadToS3FromLocal
);

module.exports = router;
