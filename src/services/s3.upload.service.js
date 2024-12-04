"use strict";

const {
  s3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require("../configs/s3.config");
// const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { getSignedUrl } = require("@aws-sdk/cloudfront-signer");

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
    const expiration = 60 * 1000; // ? 60 seconds
    // const getCommand = new GetObjectCommand({
    //   Bucket: process.env.AWS_BUCKET_NAME,
    //   Key: imgName,
    // });
    const cloudfrontURL = `${process.env.AWS_CLOUDFRONT_DOMAIN}/${imgName}`;
    const url = getSignedUrl({
      url: cloudfrontURL,
      keyPairId: process.env.AWS_CLOUDFRONT_PUBLIC_KEY_ID,
      dateLessThan: new Date(Date.now() + expiration), // ? expires in 1 mins
      privateKey: process.env.AWS_CLOUDFRONT_PRIVATE_KEY,
    });
    return { public_url: url };
  } catch (error) {
    console.log("error when uploading to AWS: ", error);
  }
};

module.exports = {
  uploadImageFromLocal,
};
