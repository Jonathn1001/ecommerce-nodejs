"use strict";

const S3UploadService = require("../services/s3.upload.service");
const CloudinaryUploadService = require("../services/cloudinary.upload.service");
const { catchAsync } = require("../helpers");
const { SuccessResponse } = require("../utils/SuccessResponse");
const { BadRequestError } = require("../utils/AppError");

class UploadController {
  // ~ ---------------- [ S3 Upload ] ------------------------
  // TODO: Upload Single File From Local
  uploadToS3FromLocal = catchAsync(async (req, res) => {
    const { file } = req;
    if (!file)
      throw new BadRequestError({
        message: "Please select a file to upload",
        statusCode: 400,
      }).send(res);

    return new SuccessResponse({
      message: "Upload image to S3 successfully",
      metadata: await S3UploadService.uploadImageFromLocal({ file }),
    }).send(res);
  });

  // ~ ---------------- [ Cloudinary Upload ] ------------------------
  //TODO:Upload Image
  uploadImage = catchAsync(async (req, res) => {
    return new SuccessResponse({
      message: "Upload image successfully",
      metadata: await CloudinaryUploadService.uploadImageFromURL(req.body),
    }).send(res);
  });

  // TODO: Upload Single File From Local
  uploadFromLocal = catchAsync(async (req, res) => {
    const { file } = req;
    if (!file)
      return new BadRequestError({
        message: "Please select a file to upload",
        statusCode: 400,
      }).send(res);

    return new SuccessResponse({
      message: "Upload thumbnail successfully",
      metadata: await CloudinaryUploadService.uploadImageFromLocal({
        path: file.path,
        name: file.originalname,
      }),
    }).send(res);
  });
  // TODO: Upload Multiple Files From Local
  uploadMultipleImagesFromLocal = catchAsync(async (req, res) => {
    const { files } = req;
    if (!files || !files.length)
      return new BadRequestError({
        message: "Please select a file to upload",
        statusCode: 400,
      }).send(res);

    return new SuccessResponse({
      message: "Upload multiple successfully",
      metadata: await CloudinaryUploadService.uploadMultipleImagesFromLocal({
        files,
      }),
    }).send(res);
  });
}

module.exports = new UploadController();
