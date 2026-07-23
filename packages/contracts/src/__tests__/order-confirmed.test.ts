import { describe, it, expect } from "vitest";
import { ORDER_CONFIRMED, OrderConfirmedPayloadSchema } from "../events/order";

describe("order.confirmed contract", () => {
  it("has the expected type string", () => {
    expect(ORDER_CONFIRMED).toBe("order.confirmed");
  });
  it("validates { orderId } and rejects empty", () => {
    expect(OrderConfirmedPayloadSchema.parse({ orderId: "o1" })).toEqual({ orderId: "o1" });
    expect(OrderConfirmedPayloadSchema.safeParse({ orderId: "" }).success).toBe(false);
    expect(OrderConfirmedPayloadSchema.safeParse({}).success).toBe(false);
  });
});
