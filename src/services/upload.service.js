"use strict";

const cloudinary = require("../configs/cloudinary.config");

// ? Upload image from URL
const uploadImageFromURL = async ({ imgUrl = "" }) => {
  try {
    const folderName = `product/elgnas`,
      newFileName = "test-image";

    const result = await cloudinary.uploader.upload(imgUrl, {
      public_id: newFileName,
      folder: folderName,
    });
    console.log("result", result);
    return result;
  } catch (error) {
    console.log("!!error when uploading image: ", error);
  }
};

// ? Upload Single Image From Local
const uploadImageFromLocal = async ({
  name = "thumbnail",
  path = "",
  folderName = "product/elgnas",
}) => {
  try {
    console.log("path", path);
    const result = await cloudinary.uploader.upload(path, {
      public_id: name,
      folder: folderName,
    });
    return {
      secure_url: result.secure_url,
      public_id: result.public_id,
      thumb_url: cloudinary.url(result.public_id, {
        height: 150,
        width: 150,
        format: "jpg",
      }),
    };
  } catch (error) {
    console.log("!!error when uploading image: ", error);
  }
};

// ? Upload Multiple Images From Local
const uploadMultipleImagesFromLocal = async ({
  files = [],

  folderName = "product/elgnas",
}) => {
  try {
    console.log("files", files);
    const uploadedImages = [];
    if (!files.length) return uploadedImages;
    for (let file of files) {
      const result = await cloudinary.uploader.upload(file.path, {
        folder: folderName,
      });
      uploadedImages.push({
        secure_url: result.secure_url,
        public_id: result.public_id,
        thumb_url: cloudinary.url(result.public_id, {
          height: 200,
          width: 200,
          format: "jpg",
        }),
      });
    }
    return uploadedImages;
  } catch (error) {
    console.log("!!error when uploading image: ", error);
  }
};

module.exports = {
  uploadImageFromURL,
  uploadImageFromLocal,
  uploadMultipleImagesFromLocal,
};
