import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { verifyWebhookSignature } from "../webhook-signature";

const SECRET = "topsecret";
const body = JSON.stringify({ orderId: "o1", outcome: "SUCCEEDED" });
const sign = (b: string, s = SECRET) =>
  `sha256=${createHmac("sha256", s).update(b).digest("hex")}`;

describe("verifyWebhookSignature", () => {
  it("accepts a correct signature", () => {
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });
  it("rejects a missing header, a wrong secret, and a tampered body", () => {
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, sign(body, "wrong"), SECRET)).toBe(false);
    expect(verifyWebhookSignature(body + " ", sign(body), SECRET)).toBe(false);
  });
  it("rejects malformed headers without throwing", () => {
    expect(verifyWebhookSignature(body, "nonsense", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "sha256=zzzz", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "sha256=", SECRET)).toBe(false);
  });
});
