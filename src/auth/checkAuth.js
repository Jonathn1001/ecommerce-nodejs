"use strict";
const JWT = require("jsonwebtoken");

const { catchAsync } = require("../helpers");
const { findById } = require("../services/apiKey.service");
const KeyTokenService = require("../services/keyToken.service");

const {
  NotFoundError,
  AuthenticationError,
  ForbiddenError,
  BadRequestError,
} = require("../utils/AppError");

const HEADER = {
  API_KEY: "x-api-key",
  CLIENT_ID: "x-client-id",
  AUTHORIZATION: "authorization",
  REFRESH_TOKEN: "x-rtoken-id",
};

const apiKey = catchAsync(async (req, res, next) => {
  const key = req.headers[HEADER.API_KEY]?.toString();
  if (!key) {
    return res.status(403).json({
      message: "Forbidden Error",
    });
  }
  // check objKey
  const objKey = await findById(key);
  if (!objKey) {
    return res.status(403).json({
      message: "Forbidden Error",
    });
  }
  req.objKey = objKey;
  return next();
});

const permissions = (permission) => {
  return (req, res, next) => {
    if (!req.objKey.permissions) {
      return res.status(403).json({
        message: "Permissions denied",
      });
    }
    const isValidPermissions = req.objKey.permissions.includes(permission);
    if (!isValidPermissions) {
      return res.status(403).json({
        message: "Permissions denied",
      });
    }
    return next();
  };
};

const authentication = catchAsync(async (req, res, next) => {
  /**
   * 1. Check user id
   * 2. Check keystore
   * 3. Verify token
   * 4. Check keyStore with this user
   * 5. Allow access if all are correct
   */

  // 1. Check user id
  const userId = req.headers[HEADER.CLIENT_ID]?.toString();
  if (!userId) throw new ForbiddenError("Invalid request");
  // 2
  const keyStore = await KeyTokenService.findByUserId(userId);
  if (!keyStore) throw new NotFoundError("KeyStore not found");

  // 3
  if (req.headers[HEADER.REFRESH_TOKEN]) {
    try {
      const refreshToken = req.headers[HEADER.REFRESH_TOKEN];
      const decodeUser = JWT.verify(refreshToken, keyStore.privateKey);
      if (userId !== decodeUser.userId)
        throw new AuthenticationError("Invalid UserID");
      req.keyStore = keyStore;
      req.user = decodeUser;
      req.refreshToken = refreshToken;
      return next();
    } catch (error) {
      throw new BadRequestError("Invalid request");
    }
  }

  try {
    const accessToken = req.headers[HEADER.AUTHORIZATION].split(" ")[1];
    const decodeUser = JWT.verify(accessToken, keyStore.publicKey);
    if (userId !== decodeUser.userId)
      throw new AuthenticationError("Invalid UserID");
    req.keyStore = keyStore;
    req.user = decodeUser;
    return next();
  } catch (error) {
    throw new BadRequestError("Invalid request");
  }
});

module.exports = {
  apiKey,
  permissions,
  authentication,
};
