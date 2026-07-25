import { describe, it, expect } from "vitest";
import {
  IDENTITY_USER_REGISTERED,
  UserRegisteredPayloadSchema,
} from "../events/identity";

describe("identity.user_registered contract", () => {
  it("has the expected type string", () => {
    expect(IDENTITY_USER_REGISTERED).toBe("identity.user_registered");
  });

  it("requires a userId and a valid email", () => {
    expect(
      UserRegisteredPayloadSchema.parse({ userId: "u1", email: "a@b.test" })
    ).toEqual({ userId: "u1", email: "a@b.test" });
    expect(UserRegisteredPayloadSchema.safeParse({}).success).toBe(false);
    expect(UserRegisteredPayloadSchema.safeParse({ userId: "u1" }).success).toBe(false);
    expect(
      UserRegisteredPayloadSchema.safeParse({ userId: "", email: "a@b.test" }).success
    ).toBe(false);
    expect(
      UserRegisteredPayloadSchema.safeParse({ userId: "u1", email: "nope" }).success
    ).toBe(false);
  });
});
