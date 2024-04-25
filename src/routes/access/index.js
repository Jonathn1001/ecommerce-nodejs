"use strict";

const express = require("express");
const router = express.Router();
const accessController = require("../../controller/access.controller");

router.post("/sign-up", accessController.signUp);

module.exports = router;
