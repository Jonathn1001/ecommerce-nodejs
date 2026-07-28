import { describe, it, expect } from "vitest";
import { ORDER_CONFIRMED, OrderConfirmedPayloadSchema } from "../events/order";

describe("order.confirmed contract", () => {
  it("has the expected type string", () => {
    expect(ORDER_CONFIRMED).toBe("order.confirmed");
  });
  it("validates { orderId, userId } and rejects empty", () => {
    expect(OrderConfirmedPayloadSchema.parse({ orderId: "o1", userId: "u1" })).toEqual({
      orderId: "o1",
      userId: "u1",
    });
    expect(
      OrderConfirmedPayloadSchema.safeParse({ orderId: "", userId: "u1" }).success
    ).toBe(false);
    expect(OrderConfirmedPayloadSchema.safeParse({}).success).toBe(false);
  });
});
