"use strict";

const jwt = require("jsonwebtoken");

const createTokenPair = (payload, publicKey, privateKey) => {
  try {
    const accessToken = jwt.sign(payload, publicKey, {
      expiresIn: "1d",
    });

    const refreshToken = jwt.sign(payload, privateKey, {
      expiresIn: "7d",
    });

    jwt.verify(accessToken, publicKey, (err, decoded) => {
      if (err) console.log("token verify error: ", err);
    });

    return {
      accessToken,
      refreshToken,
    };
  } catch (error) {
    return error;
  }
};

const verifyJWT = (token, keySecret) => {
  return jwt.verify(token, keySecret);
};

module.exports = {
  createTokenPair,
  verifyJWT,
};
