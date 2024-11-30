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
const inventoryRouter = require("./inventory");
const commentRouter = require("./comment");
const notificationRouter = require("./notification");
const uploadRouter = require("./upload");

const routes = (app) => {
  app.use(`/${api_version}/auth`, accessRouter);
  app.use(`/${api_version}/product`, productRouter);
  app.use(`/${api_version}/discount`, discountRouter);
  app.use(`/${api_version}/cart`, cartRouter);
  app.use(`/${api_version}/checkout`, checkoutRouter);
  app.use(`/${api_version}/inventory`, inventoryRouter);
  app.use(`/${api_version}/comment`, commentRouter);
  app.use(`/${api_version}/notification`, notificationRouter);
  app.use(`/${api_version}/upload`, uploadRouter);

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
