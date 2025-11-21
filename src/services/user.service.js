"use strict";

const userModel = require("../models/user.model");
const { BadRequestError } = require("./../utils/AppError");

const newUser = async ({ email = "", captcha = "" }) => {
  // ? 1. Check if the user already exists
  const user = await userModel.findOne({ email }).lean();
  // ? 2. If the user exists
  if (user) return BadRequestError("User already exists");
  // ? 3. If the user does not exist, send an email with OTP

  return {};
};

module.exports = { newUser };
