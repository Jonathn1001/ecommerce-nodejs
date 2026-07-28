"use strict";

const { catchAsync } = require("../helpers");
const AccessService = require("../services/access.service");
const { SuccessResponse } = require("../utils/SuccessResponse");

class AccessController {
  signUp = catchAsync(async (req, res) => {
    return (await AccessService.signUp(req.body)).send(res);
  });

  login = catchAsync(async (req, res) => {
    return (await AccessService.login(req.body)).send(res);
  });

  logout = catchAsync(async (req, res) => {
    new SuccessResponse({
      message: "Logout successfully",
      metadata: await AccessService.logout(req.keyStore),
    }).send(res);
  });

  handleRefreshToken = catchAsync(async (req, res) => {
    return (
      await AccessService.handleRefreshToken({
        keyStore: req.keyStore,
        refreshToken: req.refreshToken,
        user: req.user,
      })
    ).send(res);
  });
}

module.exports = new AccessController();
