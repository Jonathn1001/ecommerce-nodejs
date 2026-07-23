import { describe, it, expect } from "vitest";
import { nextStatus, applyInventoryResult, type TransitionTx } from "../transition";
import {
  INVENTORY_RESERVED,
  INVENTORY_RESERVATION_FAILED,
  ORDER_CANCELLED,
} from "@ecom/contracts";

function fakeTx(initialStatus: string | null) {
  const processed = new Set<string>();
  const emitted: Array<{ type: string; orderId: string; payload: unknown }> = [];
  let status = initialStatus;
  const tx: TransitionTx = {
    async loadOrderStatus() {
      return status;
    },
    async markProcessed(eventId) {
      if (processed.has(eventId)) return false;
      processed.add(eventId);
      return true;
    },
    async setStatus(_orderId, s) {
      status = s;
    },
    async enqueue(type, orderId, payload) {
      emitted.push({ type, orderId, payload });
    },
  };
  return { tx, emitted, processed, statusNow: () => status };
}

describe("nextStatus (pure transition table)", () => {
  it("PENDING + reserved -> AWAITING_PAYMENT", () => {
    expect(nextStatus("PENDING", INVENTORY_RESERVED)).toBe("AWAITING_PAYMENT");
  });
  it("PENDING + failed -> CANCELLED", () => {
    expect(nextStatus("PENDING", INVENTORY_RESERVATION_FAILED)).toBe("CANCELLED");
  });
  it("guards every other (status, event) to null", () => {
    expect(nextStatus("AWAITING_PAYMENT", INVENTORY_RESERVED)).toBeNull();
    expect(nextStatus("CANCELLED", INVENTORY_RESERVATION_FAILED)).toBeNull();
    expect(nextStatus("PENDING", "something.else")).toBeNull();
  });
});

describe("applyInventoryResult", () => {
  it("reserved on a PENDING order -> AWAITING_PAYMENT, ledgered, no emit", async () => {
    const f = fakeTx("PENDING");
    const outcome = await applyInventoryResult(f.tx, {
      eventId: "e1",
      type: INVENTORY_RESERVED,
      orderId: "o1",
    });
    expect(outcome).toBe("AWAITING_PAYMENT");
    expect(f.statusNow()).toBe("AWAITING_PAYMENT");
    expect(f.processed.has("e1")).toBe(true);
    expect(f.emitted).toEqual([]);
  });

  it("failed on a PENDING order -> CANCELLED and emits OrderCancelled", async () => {
    const f = fakeTx("PENDING");
    const outcome = await applyInventoryResult(f.tx, {
      eventId: "e2",
      type: INVENTORY_RESERVATION_FAILED,
      orderId: "o2",
    });
    expect(outcome).toBe("CANCELLED");
    expect(f.statusNow()).toBe("CANCELLED");
    expect(f.emitted).toEqual([
      { type: ORDER_CANCELLED, orderId: "o2", payload: { orderId: "o2" } },
    ]);
  });

  it("unknown order -> UNKNOWN_ORDER without ledgering (replay-safe)", async () => {
    const f = fakeTx(null);
    const outcome = await applyInventoryResult(f.tx, {
      eventId: "e3",
      type: INVENTORY_RESERVED,
      orderId: "missing",
    });
    expect(outcome).toBe("UNKNOWN_ORDER");
    expect(f.processed.size).toBe(0); // NOT ledgered
    expect(f.emitted).toEqual([]);
  });

  it("dedupes a redelivered event (second call is DUPLICATE, no re-effect)", async () => {
    const f = fakeTx("PENDING");
    await applyInventoryResult(f.tx, {
      eventId: "e4",
      type: INVENTORY_RESERVED,
      orderId: "o4",
    });
    const outcome = await applyInventoryResult(f.tx, {
      eventId: "e4",
      type: INVENTORY_RESERVED,
      orderId: "o4",
    });
    expect(outcome).toBe("DUPLICATE");
    expect(f.statusNow()).toBe("AWAITING_PAYMENT"); // unchanged
    expect(f.emitted).toEqual([]);
  });

  it("out-of-order guard: reserved on a CANCELLED order -> NO_OP", async () => {
    const f = fakeTx("CANCELLED");
    const outcome = await applyInventoryResult(f.tx, {
      eventId: "e5",
      type: INVENTORY_RESERVED,
      orderId: "o5",
    });
    expect(outcome).toBe("NO_OP");
    expect(f.statusNow()).toBe("CANCELLED");
  });
});
