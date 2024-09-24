"use strict";

const {
  app: { api_version },
} = require("../configs/config.mongodb");
const { AppError } = require("../utils/AppError");

const accessRouter = require("./access");
const productRouter = require("./product");
const discountRouter = require("./discount");
const cartRouter = require("./cart");
const checkoutRouter = require("./checkout");

const routes = (app) => {
  app.use(`/${api_version}/auth`, accessRouter);
  app.use(`/${api_version}/product`, productRouter);
  app.use(`/${api_version}/discount`, discountRouter);
  app.use(`/${api_version}/cart`, cartRouter);
  app.use(`/${api_version}/checkout`, checkoutRouter);

  // ? 404 Route
  app.all("*", (req, res, next) => {
    // ? create an error with status code and message
    const err = new AppError(
      `Can't find ${req.originalUrl} on this server`,
      404
    );
    // ? next() always takes error as parameter
    next(err);
  });
};

module.exports = routes;
