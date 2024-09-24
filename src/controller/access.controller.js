"use strict";

const { catchAsync } = require("../helpers");
const AccessService = require("../services/access.service");
const { SuccessResponse } = require("../utils/SuccessResponse");

class AccessController {
  signUp = catchAsync(async (req, res) => {
    return await AccessService.signUp(req.body, res);
  });

  login = catchAsync(async (req, res) => {
    return await AccessService.login(req.body, res);
  });

  logout = catchAsync(async (req, res) => {
    new SuccessResponse({
      message: "Logout successfully",
      metadata: await AccessService.logout(req.keyStore),
    }).send(res);
  });

  handleRefreshToken = catchAsync(async (req, res) => {
    return await AccessService.handleRefreshToken({
      keyStore: req.keyStore,
      refreshToken: req.refreshToken,
      user: req.user,
      res,
    });
  });
}

module.exports = new AccessController();
