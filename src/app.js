const compression = require("compression");
const express = require("express");
const { default: helmet } = require("helmet");
const morgan = require("morgan");

const routes = require("./routes");
const globalErrorHandler = require("./controller/error.controller");
const traceLog = require("./middlewares/trace-log.middleware");

const app = express();

// Init middleware
app.use(morgan(process.env.NODE_ENV === "dev" ? "dev" : "combined"));
app.use(helmet());
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(traceLog());

// Init DB
require("./dbs/init.mongodb");
// const { overloadChecker } = require("./helpers/check.connect");
// overloadChecker();

// Define Routes
routes(app);

app.use(globalErrorHandler);

module.exports = app;
