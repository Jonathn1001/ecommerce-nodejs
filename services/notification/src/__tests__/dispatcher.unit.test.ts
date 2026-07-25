import { describe, it, expect } from "vitest";
import { applyDispatch, type DispatchTx } from "../dispatcher";
import { SEND_EMAIL } from "../commands";
import { ORDER_CONFIRMED } from "@ecom/contracts";

function fakeTx(init?: { dupEvent?: boolean; dupRow?: boolean }) {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const created: Array<{ orderId: string; userId: string; type: string; to: string }> =
    [];
  const tx: DispatchTx = {
    async markProcessed() {
      return !init?.dupEvent;
    },
    async createNotification(n) {
      if (init?.dupRow) return null;
      created.push(n);
      return "n1";
    },
    async enqueue(type, _a, payload) {
      emitted.push({ type, payload });
    },
  };
  return { tx, emitted, created };
}

describe("applyDispatch", () => {
  it("creates a notification + one SendEmail(notificationId)", async () => {
    const f = fakeTx();
    const r = await applyDispatch(
      f.tx,
      { eventId: "e1", type: ORDER_CONFIRMED, orderId: "o1", userId: "u1" },
      "example.test"
    );
    expect(r).toBe("DISPATCHED");
    expect(f.created[0]).toMatchObject({
      orderId: "o1",
      userId: "u1",
      type: ORDER_CONFIRMED,
      to: "u1@example.test",
    });
    expect(f.emitted).toEqual([{ type: SEND_EMAIL, payload: { notificationId: "n1" } }]);
  });

  it("dedupes a redelivered event (markProcessed false) -> DUPLICATE, no emit", async () => {
    const f = fakeTx({ dupEvent: true });
    expect(
      await applyDispatch(
        f.tx,
        { eventId: "e1", type: ORDER_CONFIRMED, orderId: "o1", userId: "u1" },
        "example.test"
      )
    ).toBe("DUPLICATE");
    expect(f.emitted).toEqual([]);
    expect(f.created).toEqual([]);
  });

  it("dedupes a duplicate (orderId,type) row -> NOOP, no emit", async () => {
    const f = fakeTx({ dupRow: true });
    expect(
      await applyDispatch(
        f.tx,
        { eventId: "e2", type: ORDER_CONFIRMED, orderId: "o1", userId: "u1" },
        "example.test"
      )
    ).toBe("NOOP");
    expect(f.emitted).toEqual([]);
  });
});
