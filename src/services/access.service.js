"use strict";
// ~ Third party modules
const bcrypt = require("bcrypt");
const crypto = require("node:crypto");

const shopModel = require("../models/shop.model");
// ~ Services
const KeyTokenService = require("./keyToken.service");
const { findByEmail } = require("./shop.service");

// ~ Utils
const { createTokenPair, verifyJWT } = require("../auth/authUtils");
const { getInfoData } = require("../utils");
const {
  AppError,
  AuthenticationError,
  ForbiddenError,
} = require("../utils/AppError");

// ~ Constants
const { ShopRoles } = require("../constants");
const statusCodes = require("../constants/statusCodes");
const { CREATED, OK } = require("../utils/SuccessResponse");

class AccessService {
  // ** Sign Up
  static signUp = async ({ name, email, password }, res) => {
    // ? Step 1. Check if the email is already registered
    const shopHolder = await shopModel.findOne({ email }).lean(); // return an JS object, reduce the size of the object
    if (shopHolder) {
      return new AppError("Email already registered", statusCodes.BAD_REQUEST);
    }
    console.log("shopHolder: ", password);
    // ? Step 2. Hash the password and Create a new shop
    const passwordHash = await bcrypt.hash(password, 10);
    const newShop = await shopModel.create({
      name,
      email,
      password: passwordHash,
      roles: [ShopRoles.SHOP_OWNER],
    });
    // console.log("newShop: ", newShop);
    if (newShop) {
      // ? Create privateKey and publicKey
      const privateKey = crypto.randomBytes(64).toString("hex");
      const publicKey = crypto.randomBytes(64).toString("hex");

      const keyStore = await KeyTokenService.createKeyToken({
        userId: newShop._id,
        publicKey,
        privateKey,
      });

      if (!keyStore) {
        return new AppError(
          "Error while creating keys",
          statusCodes.INTERNAL_SERVER_ERROR
        );
      }

      const tokens = await createTokenPair(
        { userId: newShop._id, email },
        publicKey,
        privateKey
      );

      console.log("create token successfully: ", tokens);

      return new CREATED({
        message: "Shop created successfully",
        metadata: {
          ...tokens,
          shop: getInfoData({ fields: ["name", "email"], obj: newShop }),
        },
      }).send(res);
    }

    return new AppError(
      "Error while creating shop",
      statusCodes.INTERNAL_SERVER_ERROR
    );
  };

  // ** Login
  static login = async ({ email, password, refreshToken = null }, res) => {
    //? 1. Find Email
    const foundShop = await findByEmail({ email });
    if (!foundShop) throw new AuthenticationError("Invalid email or password");
    //? 2. Check Password
    const isMatch = await bcrypt.compare(password, foundShop.password);
    if (!isMatch) throw new AuthenticationError("Invalid email or password");

    //? 3. Generate key pair
    const publicKey = crypto.randomBytes(64).toString("hex");
    const privateKey = crypto.randomBytes(64).toString("hex");
    const userId = foundShop._id;

    //? 4. Generate Tokens
    const tokens = await createTokenPair(
      { userId, email },
      publicKey,
      privateKey
    );

    await KeyTokenService.createKeyToken({
      refreshToken: tokens.refreshToken,
      privateKey,
      publicKey,
      userId,
    });
    return new OK({
      message: "Login successful",
      metadata: {
        shop: getInfoData({ fields: ["_id", "name", "email"], obj: foundShop }),
        ...tokens,
      },
    }).send(res);
  };

  // ** Logout
  static logout = async (keyStore) => {
    const delKey = await KeyTokenService.removeKeyByID(keyStore._id);
    console.log("delKey: ", delKey);
    return delKey;
  };

  // ** Refresh Token
  static handleRefreshToken = async ({ keyStore, user, refreshToken, res }) => {
    // ? Check if the token is used
    const { userId, email } = user;
    if (keyStore.refreshTokensUsed.includes(refreshToken)) {
      await KeyTokenService.deleteByKeyId(userId);
      throw new ForbiddenError("Something went wrong!! Please login again");
    }

    if (keyStore.refreshToken !== refreshToken)
      throw new ForbiddenError("Invalid refresh token");

    const foundShop = await findByEmail({ email });
    if (!foundShop) throw new AuthenticationError("Shop not registered");

    // ? create new  token
    const tokens = await createTokenPair(
      { userId, email },
      keyStore.publicKey,
      keyStore.privateKey
    );
    console.log("keyStore: ", keyStore);
    await keyStore.updateOne({
      $set: {
        refreshToken: tokens.refreshToken,
      },
      $addToSet: {
        refreshTokensUsed: refreshToken,
      },
    });

    return new OK({
      message: "Refresh token successfully",
      metadata: {
        shop: getInfoData({ fields: ["name", "email"], obj: foundShop }),
        ...tokens,
      },
    }).send(res);
  };
}

module.exports = AccessService;
