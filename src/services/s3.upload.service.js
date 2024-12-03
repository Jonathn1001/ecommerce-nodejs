"use strict";

const {
  s3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require("../configs/s3.config");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { formatDate } = require("../utils/date.utils");

//TODO: Upload Single Image From Local
const uploadImageFromLocal = async ({ file = {} }) => {
  try {
    const imgName = `${formatDate()}-${file.originalname}`;
    const putCommand = new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: imgName,
      Body: file.buffer,
      ContentType: file.mimetype || "image/jpeg",
    });
    // ? upload to AWS
    await s3Client.send(putCommand);
    // ? publish url
    const expiration = 3600; // ? 1 hour
    const getCommand = new GetObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: imgName,
    });
    const url = await getSignedUrl(s3Client, getCommand, {
      expiresIn: expiration,
    });
    console.log("url: ", url);
    return { public_url: `${process.env.AWS_CLOUDFRONT_DOMAIN}/${imgName}` };
  } catch (error) {
    console.log("error when uploading to AWS: ", error);
  }
};

module.exports = {
  uploadImageFromLocal,
};
