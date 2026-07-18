import { describe, it, expect } from "vitest";
import {
  AppError,
  NotFoundError,
  BadRequestError,
  AuthenticationError,
} from "../errors";

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
});
