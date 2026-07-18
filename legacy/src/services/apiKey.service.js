"use strict";

const crypto = require("crypto");

const apiKeyModel = require("../models/apiKey.model");

const generateKey = async () => {
  const newKey = await apiKeyModel.create({
    key: crypto.randomBytes(64).toString("hex"),
    permissions: ["0000"],
  });
  return newKey;
};

// generateKey().then((key) => {
//   console.log("New x-api-key:", key);
// });

const findById = async (key) => {
  const objKey = await apiKeyModel.findOne({ key, status: true }).lean();
  return objKey;
};

module.exports = {
  findById,
};
