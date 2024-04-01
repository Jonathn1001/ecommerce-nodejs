const compression = require("compression");
const express = require("express");
const { default: helmet } = require("helmet");
const morgan = require("morgan");

const dotenv = require("dotenv");

dotenv.config({
  path: `./.env.${process.env.NODE_ENV}`,
});

const app = express();

// Init middleware
app.use(morgan(process.env.NODE_ENV === "development" ? "dev" : "combined"));
app.use(helmet());
app.use(compression());

// Init DB
require("./dbs/init.mongodb");
const { overloadChecker } = require("./helpers/check.connect");
overloadChecker();

// Define Routes
app.get("/", (req, res) => {
  return res.status(200).json({
    message: "Hello World!",
  });
});

module.exports = app;
