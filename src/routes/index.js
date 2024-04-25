"use strict";

const {
  app: { api_version },
} = require("../configs/config.mongodb");

const viewRouter = require("./view");
const accessRouter = require("./access");

const routes = (app) => {
  app.use("/", viewRouter);
  app.use(`/${api_version}/auth`, accessRouter);
};
module.exports = routes;
