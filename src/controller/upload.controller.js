"use strict";

const UploadService = require("../services/upload.service");
const { catchAsync } = require("../helpers");
const { SuccessResponse } = require("../utils/SuccessResponse");
const { BadRequestError } = require("../utils/AppError");

class UploadController {
  //TODO:Upload Image
  uploadImage = catchAsync(async (req, res) => {
    return new SuccessResponse({
      message: "Upload image successfully",
      metadata: await UploadService.uploadImageFromURL(req.body),
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
      metadata: await UploadService.uploadImageFromLocal({
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
      metadata: await UploadService.uploadMultipleImagesFromLocal({
        files,
      }),
    }).send(res);
  });
}

module.exports = new UploadController();
