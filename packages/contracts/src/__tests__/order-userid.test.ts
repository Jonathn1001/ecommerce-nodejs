import { describe, it, expect } from "vitest";
import {
  OrderCancelledPayloadSchema,
  OrderConfirmedPayloadSchema,
  OrderPlacedPayloadSchema,
} from "../events/order";

// Notification (Phase 5) synthesises the recipient from userId, so every order
// event must carry it — a payload without one is a contract violation, not a
// default-to-anonymous case.
describe("order payloads require userId", () => {
  it("rejects order.confirmed without userId and keeps it when present", () => {
    expect(OrderConfirmedPayloadSchema.safeParse({ orderId: "o1" }).success).toBe(false);
    expect(OrderConfirmedPayloadSchema.parse({ orderId: "o1", userId: "u1" })).toEqual({
      orderId: "o1",
      userId: "u1",
    });
  });

  it("rejects order.cancelled without userId", () => {
    expect(OrderCancelledPayloadSchema.safeParse({ orderId: "o1" }).success).toBe(false);
    expect(OrderCancelledPayloadSchema.parse({ orderId: "o1", userId: "u1" })).toEqual({
      orderId: "o1",
      userId: "u1",
    });
  });

  it("rejects order.placed without userId", () => {
    expect(
      OrderPlacedPayloadSchema.safeParse({
        orderId: "o1",
        items: [{ productId: "p", quantity: 1 }],
      }).success
    ).toBe(false);
    expect(
      OrderPlacedPayloadSchema.parse({
        orderId: "o1",
        userId: "u1",
        items: [{ productId: "p", quantity: 1 }],
      }).userId
    ).toBe("u1");
  });

  it("rejects an empty userId", () => {
    expect(
      OrderConfirmedPayloadSchema.safeParse({ orderId: "o1", userId: "" }).success
    ).toBe(false);
  });
});
