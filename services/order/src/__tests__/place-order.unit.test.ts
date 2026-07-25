import { describe, it, expect } from "vitest";
import { placeOrder, type PlaceOrderTx } from "../place-order";
import { ORDER_PLACED } from "@ecom/contracts";

function fakeTx(prices: Record<string, number>) {
  const orders: Array<{ userId: string; items: unknown[]; totalPrice: number }> = [];
  const cleared: string[] = [];
  const emitted: Array<{ type: string; orderId: string; payload: unknown }> = [];
  let seq = 0;
  const tx: PlaceOrderTx = {
    async priceOf(productId) {
      return productId in prices ? prices[productId] : null;
    },
    async createOrder(o) {
      const orderId = `order_${++seq}`;
      orders.push(o);
      return orderId;
    },
    async clearCart(userId) {
      cleared.push(userId);
    },
    async enqueue(type, orderId, payload) {
      emitted.push({ type, orderId, payload });
    },
  };
  return { tx, orders, cleared, emitted };
}

describe("placeOrder", () => {
  it("prices the cart, creates a PENDING order, clears the cart, emits OrderPlaced", async () => {
    const f = fakeTx({ p1: 100, p2: 250 });
    const res = await placeOrder(f.tx, {
      userId: "u1",
      items: [
        { productId: "p1", quantity: 2 },
        { productId: "p2", quantity: 1 },
      ],
    });
    expect(res.outcome).toBe("PLACED");
    expect(res.orderId).toBe("order_1");
    expect(f.orders).toHaveLength(1);
    expect(f.orders[0].totalPrice).toBe(2 * 100 + 1 * 250); // 450
    expect(f.cleared).toEqual(["u1"]);
    expect(f.emitted).toEqual([
      {
        type: ORDER_PLACED,
        orderId: "order_1",
        payload: {
          orderId: "order_1",
          userId: "u1",
          items: [
            { productId: "p1", quantity: 2 },
            { productId: "p2", quantity: 1 },
          ],
        },
      },
    ]);
  });

  it("returns EMPTY with no writes for an empty cart", async () => {
    const f = fakeTx({});
    const res = await placeOrder(f.tx, { userId: "u1", items: [] });
    expect(res.outcome).toBe("EMPTY");
    expect(f.orders).toHaveLength(0);
    expect(f.cleared).toHaveLength(0);
    expect(f.emitted).toHaveLength(0);
  });

  it("returns UNPRICED with no writes when any line has no price; cart intact", async () => {
    const f = fakeTx({ p1: 100 });
    const res = await placeOrder(f.tx, {
      userId: "u1",
      items: [
        { productId: "p1", quantity: 1 },
        { productId: "pX", quantity: 1 },
      ],
    });
    expect(res.outcome).toBe("UNPRICED");
    expect(res.unpricedProductId).toBe("pX");
    expect(f.orders).toHaveLength(0);
    expect(f.cleared).toHaveLength(0);
    expect(f.emitted).toHaveLength(0);
  });

  it("treats a zero (or negative) price as unpriced", async () => {
    const f = fakeTx({ p1: 0 });
    const res = await placeOrder(f.tx, {
      userId: "u1",
      items: [{ productId: "p1", quantity: 1 }],
    });
    expect(res.outcome).toBe("UNPRICED");
  });
});
