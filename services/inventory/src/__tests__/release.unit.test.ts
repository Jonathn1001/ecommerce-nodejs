import { describe, it, expect } from "vitest";
import {
  releaseRows,
  releaseForCancel,
  type ReleaseTx,
  type ReleasableRow,
} from "../release";
import { INVENTORY_RELEASED } from "@ecom/contracts";

function fake(active: Record<string, ReleasableRow[]>, stock: Record<string, number>) {
  const processed = new Set<string>();
  const released = new Set<string>();
  const emitted: Array<{ type: string; orderId: string; payload: unknown }> = [];
  const tx: ReleaseTx = {
    async markProcessed(eventId) {
      if (processed.has(eventId)) return false;
      processed.add(eventId);
      return true;
    },
    async activeByOrder(orderId) {
      return (active[orderId] ?? []).filter((r) => !released.has(r.id));
    },
    async increment(productId, qty) {
      stock[productId] = (stock[productId] ?? 0) + qty;
    },
    async markReleased(id) {
      if (released.has(id)) return false;
      released.add(id);
      return true;
    },
    async enqueue(type, orderId, payload) {
      emitted.push({ type, orderId, payload });
    },
  };
  return { tx, stock, released, emitted };
}

describe("release core", () => {
  it("releaseForCancel restores stock, marks reservations RELEASED, emits InventoryReleased", async () => {
    const f = fake({ o1: [{ id: "r1", productId: "p1", quantity: 2 }] }, { p1: 3 });
    const outcome = await releaseForCancel(f.tx, { eventId: "e1", orderId: "o1" });
    expect(outcome).toBe("RELEASED");
    expect(f.stock).toEqual({ p1: 5 });
    expect(f.released.has("r1")).toBe(true);
    expect(f.emitted).toEqual([
      {
        type: INVENTORY_RELEASED,
        orderId: "o1",
        payload: { orderId: "o1", items: [{ productId: "p1", quantity: 2 }] },
      },
    ]);
  });

  it("no-ops (no emit) when the order has no ACTIVE reservations", async () => {
    const f = fake({ o2: [] }, {});
    const outcome = await releaseForCancel(f.tx, { eventId: "e2", orderId: "o2" });
    expect(outcome).toBe("NOOP");
    expect(f.emitted).toHaveLength(0);
  });

  it("skips a duplicate cancel", async () => {
    const f = fake({ o3: [{ id: "r3", productId: "p1", quantity: 1 }] }, { p1: 0 });
    await releaseForCancel(f.tx, { eventId: "e3", orderId: "o3" });
    const outcome = await releaseForCancel(f.tx, { eventId: "e3", orderId: "o3" });
    expect(outcome).toBe("DUPLICATE");
    expect(f.stock).toEqual({ p1: 1 }); // released once, not twice
  });

  it("releaseRows returns NOOP and emits nothing for an empty set", async () => {
    const f = fake({}, {});
    const outcome = await releaseRows(f.tx, "o9", []);
    expect(outcome).toBe("NOOP");
    expect(f.emitted).toHaveLength(0);
  });

  it("guards against double-credit when the same row is released twice (e.g. sweeper + cancel race)", async () => {
    const f = fake({}, { p1: 3 });
    const row: ReleasableRow = { id: "r10", productId: "p1", quantity: 2 };

    // First releaser wins the flip and credits stock.
    const first = await releaseRows(f.tx, "o10", [row]);
    expect(first).toBe("RELEASED");
    expect(f.stock).toEqual({ p1: 5 });

    // Second releaser (racing concurrent caller) sees an already-RELEASED row:
    // the conditional markReleased loses, so no credit and no emit.
    const second = await releaseRows(f.tx, "o10", [row]);
    expect(second).toBe("NOOP");
    expect(f.stock).toEqual({ p1: 5 }); // unchanged — no double credit
    expect(f.emitted).toHaveLength(1); // only the first call's emit
  });
});
