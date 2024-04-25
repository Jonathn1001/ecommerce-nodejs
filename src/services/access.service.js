"use strict";
const shopModel = require("../models/shop.model");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { ShopRoles } = require("../constants/index");
const KeyTokenService = require("./keyToken.service");
const { createTokenPair } = require("../auth/authUtils");
const { getInfoData } = require("../utils");

class AccessService {
  static signUp = async ({ name, email, password }) => {
    try {
      // ? Step 1. Check if the email is already registered
      const shopHolder = await shopModel.findOne({ email }).lean(); // return an JS object, reduce the size of the object
      if (shopHolder) {
        return new AppError("Shop with given email already exist!", 400);
      }
      // ? Step 2. Hash the password and Create a new shop
      const passwordHash = await bcrypt.hash(password, 10);
      const newShop = await shopModel.create({
        name,
        email,
        password: passwordHash,
        roles: [ShopRoles.SHOP_OWNER],
      });
      if (newShop) {
        // ? Create privateKey and publicKey
        const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
          modulusLength: 4096,
          publicKeyEncoding: {
            type: "pkcs1",
            format: "pem",
          },
          privateKeyEncoding: {
            type: "pkcs1",
            format: "pem",
          },
        });

        console.log(privateKey, publicKey);

        const publicKeyString = await KeyTokenService.createKeyToken({
          userId: newShop._id,
          publicKey,
        });

        if (!publicKeyString) {
          return {
            code: "500",
            message: "Error",
            error: "Error while creating publicKey",
          };
        }

        const publicKeyObject = crypto.createPublicKey(publicKeyString);

        const tokens = await createTokenPair(
          { userId: newShop._id, email },
          publicKeyObject,
          privateKey
        );

        console.log("create token successfully: ", tokens);

        return {
          code: "201",
          message: "Shop Created",
          data: {
            shop: getInfoData({ fields: ["name", "email"], obj: newShop }),
            tokens,
          },
        };
      }

      return {
        code: "500",
        message: "Error",
        error: "Error while creating new shop",
      };
    } catch (error) {
      return {
        code: "500",
        message: "Error",
        error: error.message,
      };
    }
  };
}

module.exports = AccessService;
