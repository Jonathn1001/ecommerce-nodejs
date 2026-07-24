import { describe, it, expect } from "vitest";
import { nextStatus, applyResult, type TransitionTx } from "../transition";
import {
  INVENTORY_RESERVED,
  INVENTORY_RESERVATION_FAILED,
  ORDER_CANCELLED,
  ORDER_CONFIRMED,
  CHARGE_PAYMENT,
  PAYMENT_SUCCEEDED,
  PAYMENT_FAILED,
} from "@ecom/contracts";

function fakeTx(init: { status: string | null; totalPrice?: number }) {
  const processed = new Set<string>();
  const emitted: Array<{ type: string; orderId: string; payload: unknown }> = [];
  const notified: Array<{ orderId: string; status: string }> = [];
  let status = init.status;
  const totalPrice = init.totalPrice ?? 500;
  const tx: TransitionTx = {
    async loadOrder() {
      return status === null ? null : { status, totalPrice };
    },
    async markProcessed(eventId) {
      if (processed.has(eventId)) return false;
      processed.add(eventId);
      return true;
    },
    async setStatus(_o, s) {
      status = s;
    },
    async enqueue(type, orderId, payload) {
      emitted.push({ type, orderId, payload });
    },
    async notify(orderId, status) {
      notified.push({ orderId, status });
    },
  };
  return { tx, emitted, processed, notified, statusNow: () => status };
}

describe("nextStatus (widened table)", () => {
  it("PENDING + reserved -> AWAITING_PAYMENT", () => {
    expect(nextStatus("PENDING", INVENTORY_RESERVED)).toBe("AWAITING_PAYMENT");
  });
  it("PENDING + reservation-failed -> CANCELLED", () => {
    expect(nextStatus("PENDING", INVENTORY_RESERVATION_FAILED)).toBe("CANCELLED");
  });
  it("AWAITING_PAYMENT + payment-succeeded -> CONFIRMED", () => {
    expect(nextStatus("AWAITING_PAYMENT", PAYMENT_SUCCEEDED)).toBe("CONFIRMED");
  });
  it("AWAITING_PAYMENT + payment-failed -> CANCELLED", () => {
    expect(nextStatus("AWAITING_PAYMENT", PAYMENT_FAILED)).toBe("CANCELLED");
  });
  it("guards every other pair to null", () => {
    expect(nextStatus("CONFIRMED", PAYMENT_SUCCEEDED)).toBeNull();
    expect(nextStatus("PENDING", PAYMENT_SUCCEEDED)).toBeNull();
    expect(nextStatus("AWAITING_PAYMENT", INVENTORY_RESERVED)).toBeNull();
  });
});

describe("applyResult", () => {
  it("reserved -> AWAITING_PAYMENT and emits ChargePayment(amount=totalPrice)", async () => {
    const f = fakeTx({ status: "PENDING", totalPrice: 700 });
    const outcome = await applyResult(f.tx, {
      eventId: "e1",
      type: INVENTORY_RESERVED,
      orderId: "o1",
    });
    expect(outcome).toBe("AWAITING_PAYMENT");
    expect(f.emitted).toEqual([
      { type: CHARGE_PAYMENT, orderId: "o1", payload: { orderId: "o1", amount: 700 } },
    ]);
  });
  it("reservation-failed -> CANCELLED + OrderCancelled", async () => {
    const f = fakeTx({ status: "PENDING" });
    const outcome = await applyResult(f.tx, {
      eventId: "e2",
      type: INVENTORY_RESERVATION_FAILED,
      orderId: "o2",
    });
    expect(outcome).toBe("CANCELLED");
    expect(f.emitted).toEqual([
      { type: ORDER_CANCELLED, orderId: "o2", payload: { orderId: "o2" } },
    ]);
  });
  it("payment-succeeded -> CONFIRMED + OrderConfirmed", async () => {
    const f = fakeTx({ status: "AWAITING_PAYMENT" });
    const outcome = await applyResult(f.tx, {
      eventId: "e3",
      type: PAYMENT_SUCCEEDED,
      orderId: "o3",
    });
    expect(outcome).toBe("CONFIRMED");
    expect(f.emitted).toEqual([
      { type: ORDER_CONFIRMED, orderId: "o3", payload: { orderId: "o3" } },
    ]);
  });
  it("payment-failed -> CANCELLED + OrderCancelled", async () => {
    const f = fakeTx({ status: "AWAITING_PAYMENT" });
    const outcome = await applyResult(f.tx, {
      eventId: "e4",
      type: PAYMENT_FAILED,
      orderId: "o4",
    });
    expect(outcome).toBe("CANCELLED");
    expect(f.emitted).toEqual([
      { type: ORDER_CANCELLED, orderId: "o4", payload: { orderId: "o4" } },
    ]);
  });
  it("unknown order -> UNKNOWN_ORDER without ledgering", async () => {
    const f = fakeTx({ status: null });
    expect(
      await applyResult(f.tx, { eventId: "e5", type: PAYMENT_SUCCEEDED, orderId: "x" })
    ).toBe("UNKNOWN_ORDER");
    expect(f.processed.size).toBe(0);
  });
  it("dedupes a redelivered event", async () => {
    const f = fakeTx({ status: "AWAITING_PAYMENT" });
    await applyResult(f.tx, { eventId: "e6", type: PAYMENT_SUCCEEDED, orderId: "o6" });
    expect(
      await applyResult(f.tx, { eventId: "e6", type: PAYMENT_SUCCEEDED, orderId: "o6" })
    ).toBe("DUPLICATE");
  });
  it("out-of-order guard: payment-succeeded on CONFIRMED -> NO_OP", async () => {
    const f = fakeTx({ status: "CONFIRMED" });
    expect(
      await applyResult(f.tx, { eventId: "e7", type: PAYMENT_SUCCEEDED, orderId: "o7" })
    ).toBe("NO_OP");
  });
  it("emits a NOTIFY with the new status on each transition", async () => {
    const f = fakeTx({ status: "AWAITING_PAYMENT" });
    await applyResult(f.tx, { eventId: "n1", type: PAYMENT_SUCCEEDED, orderId: "o9" });
    expect(f.notified).toEqual([{ orderId: "o9", status: "CONFIRMED" }]);
  });
  it("does not NOTIFY on a guarded NO_OP", async () => {
    const f = fakeTx({ status: "CONFIRMED" });
    await applyResult(f.tx, { eventId: "n2", type: PAYMENT_SUCCEEDED, orderId: "o9" });
    expect(f.notified).toEqual([]);
  });
});
