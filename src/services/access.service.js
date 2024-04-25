"use strict";
const shopModel = require("../models/shop.model");
const bcrypt = require("bcrypt");
const crypto = require("node:crypto");
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
        return {
          code: "400",
          message: "Error",
          error: "Email already registered",
        };
      }
      // ? Step 2. Hash the password and Create a new shop
      const passwordHash = await bcrypt.hash(password, 10);
      const newShop = await shopModel.create({
        name,
        email,
        password: passwordHash,
        roles: [ShopRoles.SHOP_OWNER],
      });
      console.log("newShop: ", newShop);
      if (newShop) {
        // ? Create privateKey and publicKey
        // const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
        //   modulusLength: 4096,
        //   publicKeyEncoding: {
        //     type: "pkcs1",
        //     format: "pem",
        //   },
        //   privateKeyEncoding: {
        //     type: "pkcs1",
        //     format: "pem",
        //   },
        // });
        const privateKey = crypto.randomBytes(64).toString("hex");
        const publicKey = crypto.randomBytes(64).toString("hex");
        console.log(privateKey, publicKey);

        const keyStore = await KeyTokenService.createKeyToken({
          userId: newShop._id,
          publicKey,
          privateKey,
        });

        if (!keyStore) {
          return {
            code: "500",
            message: "Error",
            error: "Error while creating keys",
          };
        }

        // const publicKeyObject = crypto.createPublicKey(publicKeyString);

        const tokens = await createTokenPair(
          { userId: newShop._id, email },
          publicKey,
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
