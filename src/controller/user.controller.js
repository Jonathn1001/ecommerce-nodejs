// Desc: User controller for handling user related operations
"use strict";
const { catchAsync } = require("../helpers");

class UserController {
  newUser = catchAsync(async (req, res) => {});
}

module.exports = new UserController();
