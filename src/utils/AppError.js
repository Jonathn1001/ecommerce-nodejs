const Reasons = require("./../constants/reasonPhrases");
const StatusCodes = require("./../constants/statusCodes");

class AppError extends Error {
  constructor(message, statusCode) {
    // ? inherit the parent constructor => Error constructor take it as error message
    super(message);
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith(4) ? "fail" : "err";
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

class NotFoundError extends AppError {
  constructor(
    message = Reasons.NOT_FOUND,
    statusCodes = StatusCodes.NOT_FOUND
  ) {
    super(message, statusCodes);
  }
}

class AuthenticationError extends AppError {
  constructor(
    message = Reasons.UNAUTHORIZED,
    statusCodes = StatusCodes.UNAUTHORIZED
  ) {
    super(message, statusCodes);
  }
}

class ForbiddenError extends AppError {
  constructor(message = Reasons.FORBIDDEN, statusCode = StatusCodes.FORBIDDEN) {
    super(message, statusCode);
  }
}
class BadRequestError extends AppError {
  constructor(
    message = Reasons.BAD_REQUEST,
    statusCode = StatusCodes.BAD_REQUEST
  ) {
    super(message, statusCode);
  }
}
module.exports = {
  AppError,
  NotFoundError,
  AuthenticationError,
  ForbiddenError,
  BadRequestError,
};
