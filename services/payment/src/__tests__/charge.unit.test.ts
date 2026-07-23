import { describe, it, expect } from "vitest";
import { simulateCharge, chargeOrder, type ChargeTx } from "../charge";
import { PAYMENT_SUCCEEDED, PAYMENT_FAILED } from "@ecom/contracts";

function fakeTx(seed: { existingOrders?: string[] } = {}) {
  const processed = new Set<string>();
  const payments = new Set<string>(seed.existingOrders ?? []);
  const emitted: Array<{ type: string; orderId: string; payload: unknown }> = [];
  let seq = 0;
  const tx: ChargeTx = {
    async markProcessed(eventId) {
      if (processed.has(eventId)) return false;
      processed.add(eventId);
      return true;
    },
    async paymentExists(orderId) {
      return payments.has(orderId);
    },
    async createPayment(orderId) {
      payments.add(orderId);
      return `pay_${++seq}`;
    },
    async createAttempt() {},
    async enqueue(type, orderId, payload) {
      emitted.push({ type, orderId, payload });
    },
  };
  return { tx, emitted, payments, processed };
}

describe("simulateCharge (magic amounts)", () => {
  it("declines totals ending in 01, succeeds otherwise", () => {
    expect(simulateCharge(100)).toBe("SUCCEEDED");
    expect(simulateCharge(101)).toBe("FAILED");
    expect(simulateCharge(2501)).toBe("FAILED");
    expect(simulateCharge(199)).toBe("SUCCEEDED");
    expect(simulateCharge(1)).toBe("FAILED");
    expect(simulateCharge(99)).toBe("SUCCEEDED"); // 99 reserved for 3c TIMEOUT, succeeds now
  });
});

describe("chargeOrder", () => {
  it("charges a fresh order -> SUCCEEDED + PaymentSucceeded", async () => {
    const f = fakeTx();
    const outcome = await chargeOrder(f.tx, { eventId: "e1", orderId: "o1", amount: 500 });
    expect(outcome).toBe("SUCCEEDED");
    expect(f.emitted).toEqual([
      { type: PAYMENT_SUCCEEDED, orderId: "o1", payload: { orderId: "o1", paymentId: "pay_1", amount: 500 } },
    ]);
  });

  it("declines a ...01 total -> FAILED + PaymentFailed(reason CARD_DECLINED)", async () => {
    const f = fakeTx();
    const outcome = await chargeOrder(f.tx, { eventId: "e2", orderId: "o2", amount: 101 });
    expect(outcome).toBe("FAILED");
    expect(f.emitted).toEqual([
      { type: PAYMENT_FAILED, orderId: "o2", payload: { orderId: "o2", reason: "CARD_DECLINED" } },
    ]);
  });

  it("dedupes a redelivered command -> DUPLICATE, no second charge", async () => {
    const f = fakeTx();
    await chargeOrder(f.tx, { eventId: "e3", orderId: "o3", amount: 500 });
    const outcome = await chargeOrder(f.tx, { eventId: "e3", orderId: "o3", amount: 500 });
    expect(outcome).toBe("DUPLICATE");
    expect(f.emitted).toHaveLength(1);
  });

  it("re-sent command for an already-charged order -> ALREADY_CHARGED", async () => {
    const f = fakeTx({ existingOrders: ["o4"] });
    const outcome = await chargeOrder(f.tx, { eventId: "e4", orderId: "o4", amount: 500 });
    expect(outcome).toBe("ALREADY_CHARGED");
    expect(f.emitted).toEqual([]);
  });
});
