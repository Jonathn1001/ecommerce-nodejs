"use strict";

const express = require("express");
const router = express.Router();

router.get("", (req, res) => {
  console.log("request");
  return res.status(200).json({
    message: "Hello World!",
  });
});

module.exports = router;
