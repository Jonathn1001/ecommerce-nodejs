"use strict";

const jwt = require("jsonwebtoken");

const createTokenPair = (payload, publicKeyObj, privateKey) => {
  try {
    const accessToken = jwt.sign(payload, privateKey, {
      algorithm: "RS256",
      expiresIn: "1d",
    });

    const refreshToken = jwt.sign(payload, privateKey, {
      algorithm: "RS256",
      expiresIn: "7d",
    });

    jwt.verify(accessToken, publicKeyObj, (err, decoded) => {
      if (err) console.log("token verify error: ", err);
      console.log("token decoded: ", decoded);
    });

    return {
      accessToken,
      refreshToken,
    };
  } catch (error) {
    return error;
  }
};

module.exports = {
  createTokenPair,
};
