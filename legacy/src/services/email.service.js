"use strict";

const { newOtp } = require("./otp.service");
const { getTemplate } = require("./template.service");

const sendEmailToken = async ({ email = "", otp = "" }) => {
  // ? 1. Generate a new OTP token
  const otp_token = newOtp({ email });
  // ? 2. Get email template
  const template = getTemplate({ name: "verify_email" });
  //? 3. Send email
};
module.exports = { sendEmailToken };
