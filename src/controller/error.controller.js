const { AppError } = require("../utils/AppError");
const statusCodes = require("../constants/statusCodes");
const WinstonLogger = require("../loggers/winston.log");

const sendErrorDev = (err, req, res) => {
  const logger = new WinstonLogger({ level: "error" });
  logger.error(err.message, {
    context: req.originalUrl,
    req,
    metadata: err.message,
  });

  // 1. API Error
  if (req.originalUrl.startsWith("/api")) {
    return res.status(err.statusCode).json({
      status: err.status,
      message: err.message,
      error: err,
      stack: err.stack,
    });
  }

  // 2. Rendered Error Page
  return res.status(err.statusCode).render("pages/error", {
    title: "Something went wrong!",
    message: err.message,
  });
};

const sendErrorProduction = (err, req, res) => {
  // 1. API Error
  if (req.originalUrl.startsWith("/api")) {
    // !! A) Operational, trusted error: send message to client
    if (err.isOperational)
      return res.status(err.statusCode).json({
        status: err.status,
        message: err.message,
      });
    // !! B) Programming or other unknown error: don't leak error details
    // ? 1. Log error
    console.log("Error 💣", err);
    // ? 2. Send Generic message
    return res.status(500).json({
      status: "error",
      message: "Aw!! Something went wrong",
    });
  }

  // 2. Rendered Error Page
  // !! A) Operational, trusted error: send message to client
  if (err.isOperational)
    return res.status(err.statusCode).render("pages/error", {
      title: "Something went wrong!",
      message: err.message,
    });

  // !! B) Programming or other unknown error: don't leak error details
  // ? 1. Log error
  console.log("Error 💣", err);
  // ? 2. Send Generic message
  return res.status(err.statusCode).render("pages/error", {
    title: "Something went wrong!",
    message: "Please try again later",
  });
};

const handleCastErrorDB = (error) => {
  const message = `Invalid ${error.path}: ${error.value}`;
  return new AppError(message, statusCodes.BAD_REQUEST);
};

const handleDuplicateFieldDB = (error) => {
  const duplicatedFields = Object.getOwnPropertyNames(error.keyPattern);
  const message = `Duplicate ${duplicatedFields[0]} ${
    error.keyValue[duplicatedFields[0]]
  }`;
  return new AppError(message, statusCodes.BAD_REQUEST);
};

const handleValidationError = (error) => {
  const errors = Object.values(error.errors).map((err) => err.message);
  const message = `Invalid Input Data: ${errors.join(". ")}`;
  return new AppError(message, statusCodes.BAD_REQUEST);
};

// ? Assume this case token was modified by someone
const handleJWTError = () =>
  new AppError(
    "Invalid token. Please login again !!!",
    statusCodes.UNAUTHORIZED
  );

const handleJWTExpiredError = () =>
  new AppError(
    "Your token has been expired. Please login again !!!",
    statusCodes.UNAUTHORIZED
  );

module.exports = (err, req, res, next) => {
  err.statusCode = err.statusCode || statusCodes.INTERNAL_SERVER_ERROR;
  err.status = err.status || "Internal Error";

  if (process.env.NODE_ENV === "dev") {
    sendErrorDev(err, req, res);
  } else if (process.env.NODE_ENV === "prod") {
    let error = { ...err };
    error.message = err.message;
    if (err.name === "CastError") error = handleCastErrorDB(error);
    if (err.code === 11000) error = handleDuplicateFieldDB(error);
    if (err.name === "ValidationError") error = handleValidationError(error);
    if (err.name === "JsonWebTokenError") error = handleJWTError();
    if (err.name === "TokenExpiredError") error = handleJWTExpiredError();
    sendErrorProduction(error, req, res);
  }
};
