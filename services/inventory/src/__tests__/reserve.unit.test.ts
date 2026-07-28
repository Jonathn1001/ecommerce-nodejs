import { describe, it, expect } from "vitest";
import { reserveOrder, type ReserveTx, type ReserveItem } from "../reserve";
import { INVENTORY_RESERVED, INVENTORY_RESERVATION_FAILED } from "@ecom/contracts";

function fakeTx(stock: Record<string, number>) {
  const processed = new Set<string>();
  const reservations: Array<{ orderId: string; item: ReserveItem }> = [];
  const emitted: Array<{ type: string; orderId: string; payload: unknown }> = [];
  const tx: ReserveTx = {
    async markProcessed(eventId) {
      if (processed.has(eventId)) return false;
      processed.add(eventId);
      return true;
    },
    async tryDecrement(productId, qty) {
      if ((stock[productId] ?? 0) < qty) return false;
      stock[productId] -= qty;
      return true;
    },
    async increment(productId, qty) {
      stock[productId] = (stock[productId] ?? 0) + qty;
    },
    async createReservation(orderId, item) {
      reservations.push({ orderId, item });
    },
    async enqueue(type, orderId, payload) {
      emitted.push({ type, orderId, payload });
    },
  };
  return { tx, stock, reservations, emitted };
}

const at = new Date("2026-07-21T00:00:00.000Z");

describe("reserveOrder", () => {
  it("reserves every item, decrements stock, emits InventoryReserved", async () => {
    const f = fakeTx({ p1: 5, p2: 3 });
    const outcome = await reserveOrder(f.tx, {
      eventId: "e1",
      orderId: "o1",
      items: [
        { productId: "p2", quantity: 1 },
        { productId: "p1", quantity: 2 },
      ],
      expiresAt: at,
    });
    expect(outcome).toBe("RESERVED");
    expect(f.stock).toEqual({ p1: 3, p2: 2 });
    expect(f.reservations).toHaveLength(2);
    expect(f.emitted).toEqual([
      {
        type: INVENTORY_RESERVED,
        orderId: "o1",
        payload: {
          orderId: "o1",
          items: [
            { productId: "p1", quantity: 2 },
            { productId: "p2", quantity: 1 },
          ],
        },
      },
    ]);
  });

  it("is all-or-nothing: a shortfall on any line restores every decrement and emits Failed", async () => {
    const f = fakeTx({ p1: 5, p2: 0 });
    const outcome = await reserveOrder(f.tx, {
      eventId: "e2",
      orderId: "o2",
      items: [
        { productId: "p1", quantity: 2 },
        { productId: "p2", quantity: 1 },
      ],
      expiresAt: at,
    });
    expect(outcome).toBe("FAILED");
    expect(f.stock).toEqual({ p1: 5, p2: 0 }); // p1's decrement was rolled back
    expect(f.reservations).toHaveLength(0);
    expect(f.emitted).toEqual([
      {
        type: INVENTORY_RESERVATION_FAILED,
        orderId: "o2",
        payload: { orderId: "o2", reason: "INSUFFICIENT_STOCK" },
      },
    ]);
  });

  it("skips a duplicate event with no side effects", async () => {
    const f = fakeTx({ p1: 5 });
    await reserveOrder(f.tx, {
      eventId: "e3",
      orderId: "o3",
      items: [{ productId: "p1", quantity: 1 }],
      expiresAt: at,
    });
    const outcome = await reserveOrder(f.tx, {
      eventId: "e3",
      orderId: "o3",
      items: [{ productId: "p1", quantity: 1 }],
      expiresAt: at,
    });
    expect(outcome).toBe("DUPLICATE");
    expect(f.stock).toEqual({ p1: 4 }); // decremented once, not twice
    expect(f.reservations).toHaveLength(1);
  });
});
