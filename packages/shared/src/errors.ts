// Typed AppError family, ported from legacy/src/utils/AppError.js.
// Every service in this workspace throws these instead of raw Error, so
// controllers/middleware can rely on `statusCode`, `status`, and
// `isOperational` being present.
import { HTTP_STATUS } from "./http-status";

export class AppError extends Error {
  statusCode: number;
  status: "fail" | "err";
  isOperational: boolean;

  constructor(message: string, statusCode: number) {
    // Pass message to the parent Error constructor.
    super(message);
    this.statusCode = statusCode;
    this.status = String(statusCode).startsWith("4") ? "fail" : "err";
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not Found") {
    super(message, HTTP_STATUS.NOT_FOUND);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, HTTP_STATUS.UNAUTHORIZED);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, HTTP_STATUS.FORBIDDEN);
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad Request") {
    super(message, HTTP_STATUS.BAD_REQUEST);
  }
}
