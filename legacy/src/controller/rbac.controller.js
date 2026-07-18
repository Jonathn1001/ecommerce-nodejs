"use strict";

const { catchAsync } = require("../helpers");
const RBACService = require("../services/rbac.service");
const { SuccessResponse } = require("../utils/SuccessResponse");

class RBACController {
  createRole = catchAsync(async (req, res) => {
    new SuccessResponse({
      message: "Create new role successfully",
      metadata: await RBACService.createRole(req.body, {
        ...req.body,
        product_shop: req.user.userId,
      }),
    }).send(res);
  });

  createResource = catchAsync(async (req, res) => {
    new SuccessResponse({
      message: "Create new resource successfully",
      metadata: await RBACService.createResource(req.body, {
        ...req.body, 
        product_shop: req.user.userId,
      }),
    }).send(res);
  });

  getRoleList = catchAsync(async (req, res) => {
    const results = await RBACService.getRoles(req.query);
    new SuccessResponse({
      message: "Get all roles successfully",
      metadata: { data: results, total: results.length },
    }).send(res);
  });

  getResourceList = catchAsync(async (req, res) => {
    const results = await RBACService.getResources(req.query);
    new SuccessResponse({
      message: "Get all resources successfully",
      metadata: { data: results, total: results.length },
    }).send(res);
  });
}

module.exports = new RBACController();
