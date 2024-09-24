"use strict";

const keyTokenModel = require("../models/keyToken.model");

class KeyTokenService {
  static createKeyToken = async ({
    userId,
    publicKey,
    privateKey,
    refreshToken,
  }) => {
    // const publicKeyString = publicKey.toString();
    // const tokens = await keyTokenModel.create({
    //   user: userId,
    //   publicKey,
    //   privateKey,
    // });
    const filter = { user: userId },
      update = {
        publicKey,
        privateKey,
        refreshTokensUsed: [],
        refreshToken,
      },
      options = { new: true, upsert: true };
    const tokens = await keyTokenModel.findOneAndUpdate(
      filter,
      update,
      options
    );
    return tokens ? tokens.publicKey : null;
  };

  static findByUserId = async (userId) => {
    const objKey = await keyTokenModel.findOne({ user: userId });
    return objKey;
  };

  static removeKeyByID = async (id) => {
    return await keyTokenModel.deleteOne({ _id: id });
  };

  static findByRefreshTokenUsed = async (refreshToken) => {
    const objKey = await keyTokenModel
      .findOne({ refreshTokensUsed: refreshToken })
      .lean();
    return objKey;
  };

  static findByRefreshToken = async (refreshToken) => {
    const objKey = await keyTokenModel.findOne({ refreshToken });
    return objKey;
  };

  static deleteByKeyId = async (userId) => {
    const objKey = await keyTokenModel.deleteOne({ user: userId });
    return objKey;
  };
}

module.exports = KeyTokenService;
