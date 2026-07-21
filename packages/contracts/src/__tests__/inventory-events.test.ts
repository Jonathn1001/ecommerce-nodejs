import { describe, it, expect } from "vitest";
import {
  OrderPlacedPayloadSchema,
  OrderCancelledPayloadSchema,
  ORDER_PLACED,
  ORDER_CANCELLED,
  InventoryReservedPayloadSchema,
  InventoryReservationFailedPayloadSchema,
  INVENTORY_RESERVED,
  INVENTORY_RESERVATION_FAILED,
  INVENTORY_RELEASED,
} from "../index";

describe("order + inventory event contracts", () => {
  it("OrderPlaced requires a non-empty item list with positive int quantities", () => {
    expect(() => OrderPlacedPayloadSchema.parse({ orderId: "o1", items: [] })).toThrow();
    expect(() =>
      OrderPlacedPayloadSchema.parse({ orderId: "o1", items: [{ productId: "p1", quantity: 0 }] })
    ).toThrow();
    const ok = OrderPlacedPayloadSchema.parse({
      orderId: "o1",
      items: [{ productId: "p1", quantity: 2 }],
    });
    expect(ok.items[0].quantity).toBe(2);
  });

  it("OrderCancelled requires an orderId", () => {
    expect(() => OrderCancelledPayloadSchema.parse({})).toThrow();
    expect(OrderCancelledPayloadSchema.parse({ orderId: "o1" }).orderId).toBe("o1");
  });

  it("InventoryReservationFailed requires a reason", () => {
    expect(() => InventoryReservationFailedPayloadSchema.parse({ orderId: "o1" })).toThrow();
    const p = InventoryReservationFailedPayloadSchema.parse({ orderId: "o1", reason: "INSUFFICIENT_STOCK" });
    expect(p.reason).toBe("INSUFFICIENT_STOCK");
  });

  it("InventoryReserved echoes orderId + items", () => {
    const p = InventoryReservedPayloadSchema.parse({ orderId: "o1", items: [{ productId: "p1", quantity: 1 }] });
    expect(p.orderId).toBe("o1");
    expect(p.items).toHaveLength(1);
  });

  it("event constants carry stable wire values", () => {
    expect(ORDER_PLACED).toBe("order.placed");
    expect(ORDER_CANCELLED).toBe("order.cancelled");
    expect(INVENTORY_RESERVED).toBe("inventory.reserved");
    expect(INVENTORY_RESERVATION_FAILED).toBe("inventory.reservation_failed");
    expect(INVENTORY_RELEASED).toBe("inventory.released");
  });
});
