"use strict";

const { randomInt } = require("crypto");
const otpModel = require("../models/otp.model");

const generateToken = () => {
  return randomInt(0, Math.pow(2, 32)).toString();
};

const newOtp = async ({ email = "" }) => {
  const token = generateToken();
  const newToken = await otpModel.create({
    otp_token: token,
    otp_email: email, 
  });
  return newToken;
};

module.exports = { newOtp };
