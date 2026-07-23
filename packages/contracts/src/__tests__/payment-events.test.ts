import { describe, it, expect } from "vitest";
import {
  CHARGE_PAYMENT,
  PAYMENT_SUCCEEDED,
  PAYMENT_FAILED,
  ChargePaymentPayloadSchema,
  PaymentSucceededPayloadSchema,
  PaymentFailedPayloadSchema,
} from "../events/payment";

describe("payment contracts", () => {
  it("has the expected event type strings", () => {
    expect(CHARGE_PAYMENT).toBe("payment.charge");
    expect(PAYMENT_SUCCEEDED).toBe("payment.succeeded");
    expect(PAYMENT_FAILED).toBe("payment.failed");
  });

  it("ChargePayment payload validates orderId + positive int amount", () => {
    expect(ChargePaymentPayloadSchema.parse({ orderId: "o1", amount: 100 })).toEqual({
      orderId: "o1",
      amount: 100,
    });
    expect(ChargePaymentPayloadSchema.safeParse({ orderId: "o1", amount: 0 }).success).toBe(false);
    expect(ChargePaymentPayloadSchema.safeParse({ orderId: "", amount: 100 }).success).toBe(false);
    expect(ChargePaymentPayloadSchema.safeParse({ orderId: "o1", amount: 1.5 }).success).toBe(false);
  });

  it("PaymentSucceeded / PaymentFailed payloads validate their shapes", () => {
    expect(
      PaymentSucceededPayloadSchema.parse({ orderId: "o1", paymentId: "p1", amount: 100 })
    ).toEqual({ orderId: "o1", paymentId: "p1", amount: 100 });
    expect(PaymentFailedPayloadSchema.parse({ orderId: "o1", reason: "CARD_DECLINED" })).toEqual({
      orderId: "o1",
      reason: "CARD_DECLINED",
    });
    expect(PaymentFailedPayloadSchema.safeParse({ orderId: "o1" }).success).toBe(false);
  });
});
