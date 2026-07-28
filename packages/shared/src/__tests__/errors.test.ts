import { describe, it, expect } from "vitest";
import {
  AppError,
  NotFoundError,
  BadRequestError,
  AuthenticationError,
  ForbiddenError,
} from "../errors";
import { HTTP_STATUS } from "../http-status";

describe("AppError family", () => {
  it("BadRequestError is a 400 fail and operational", () => {
    const e = new BadRequestError("bad");
    expect(e).toBeInstanceOf(AppError);
    expect(e.statusCode).toBe(400);
    expect(e.status).toBe("fail");
    expect(e.isOperational).toBe(true);
    expect(e.message).toBe("bad");
  });

  it("NotFoundError defaults to 404, AuthenticationError to 401", () => {
    expect(new NotFoundError().statusCode).toBe(404);
    expect(new AuthenticationError().statusCode).toBe(401);
  });

  it("status is 'err' for 5xx", () => {
    expect(new AppError("boom", 500).status).toBe("err");
  });

  it("ForbiddenError is a 403 fail and operational", () => {
    const e = new ForbiddenError();
    expect(e).toBeInstanceOf(ForbiddenError);
    expect(e).toBeInstanceOf(AppError);
    expect(e).toBeInstanceOf(Error);
    expect(e.statusCode).toBe(HTTP_STATUS.FORBIDDEN);
    expect(e.status).toBe("fail");
    expect(e.isOperational).toBe(true);
    expect(e.message).toBe("Forbidden");
  });
});
