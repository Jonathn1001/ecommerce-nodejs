import { describe, it, expect } from "vitest";
import { PAYMENT_REFUNDED, PaymentRefundedPayloadSchema } from "../events/payment";

describe("payment.refunded contract", () => {
  it("has the expected type string", () => {
    expect(PAYMENT_REFUNDED).toBe("payment.refunded");
  });
  it("validates { orderId, paymentId, amount } and rejects bad input", () => {
    expect(
      PaymentRefundedPayloadSchema.parse({ orderId: "o1", paymentId: "p1", amount: 500 })
    ).toEqual({ orderId: "o1", paymentId: "p1", amount: 500 });
    expect(PaymentRefundedPayloadSchema.safeParse({ orderId: "o1" }).success).toBe(false);
    expect(
      PaymentRefundedPayloadSchema.safeParse({
        orderId: "o1",
        paymentId: "p1",
        amount: 0,
      }).success
    ).toBe(false);
  });
});
