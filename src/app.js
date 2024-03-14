const compression = require("compression");
const express = require("express");
const { default: helmet } = require("helmet");
const morgan = require("morgan");
require("dotenv").config();

const app = express();

// Init middleware
app.use(morgan(process.env.NODE_ENV === "development" ? "dev" : "combined"));
app.use(helmet());
app.use(compression());

// Init DB

// Define Routes
app.get("/", (req, res) => {
  return res.status(200).json({
    message: "Hello World!",
  });
});

module.exports = app;
