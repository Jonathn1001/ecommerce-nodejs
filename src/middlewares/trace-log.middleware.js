"use strict";
const { v4: uuid } = require("uuid");
const WinstonLogger = require("../loggers/winston.log");

const traceLog = () => (req, res, next) => {
  req.requestId = uuid();
  const logger = new WinstonLogger({ level: "info" });
  logger.info(`${req.method}`, [
    req.path,
    { requestId: req.requestId },
    req.method === "GET" ? req.query : req.body,
  ]);
  next();
};

module.exports = traceLog;
