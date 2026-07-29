import { describe, it, expect } from "vitest";
import { applySend, type SendRow, type WorkerPort } from "../worker";
import { ORDER_CONFIRMED } from "@ecom/contracts";

// notification-metrics.unit.test.ts constructs the counter directly, so it passes whether
// or not worker.ts wires anything. These cases drive applySend itself through its injected
// port/mailer (no DB needed) and pin which of its four exit paths records what.

type Recorded = [string, string];

function fakePort(row: SendRow | null) {
  let status = row?.status;
  const port: WorkerPort = {
    async loadRow() {
      return row ? { ...row, status: status! } : null;
    },
    async casSent() {
      if (status === "PENDING") {
        status = "SENT";
        return 1;
      }
      return 0;
    },
  };
  const mailer = {
    async send() {},
  };
  return { port, mailer };
}

const row: SendRow = {
  id: "n1",
  to: "u1@example.test",
  type: ORDER_CONFIRMED,
  orderId: "o1",
  status: "PENDING",
};

describe("applySend metric recording", () => {
  it("a delivered mail records (type, sent)", async () => {
    const calls: Recorded[] = [];
    const f = fakePort(row);
    await applySend(f.port, f.mailer, "n1", (t, r) => calls.push([t, r]));
    expect(calls).toEqual([[ORDER_CONFIRMED, "sent"]]);
  });

  it("a lost CAS race records (type, skipped), not sent", async () => {
    const calls: Recorded[] = [];
    const f = fakePort(row);
    const racing: WorkerPort = {
      ...f.port,
      async casSent() {
        return 0;
      },
    };
    await applySend(racing, f.mailer, "n1", (t, r) => calls.push([t, r]));
    expect(calls).toEqual([[ORDER_CONFIRMED, "skipped"]]);
  });

  it("a throwing mailer records (type, failed) AND still propagates", async () => {
    const calls: Recorded[] = [];
    const f = fakePort(row);
    const throwing = {
      async send() {
        throw new Error("smtp down");
      },
    };
    // The rethrow is load-bearing: it is what drives consumeCommands' retry -> DLQ path
    // built in Phase 5. Recording must not swallow it.
    await expect(
      applySend(f.port, throwing, "n1", (t, r) => calls.push([t, r]))
    ).rejects.toThrow("smtp down");
    expect(calls).toEqual([[ORDER_CONFIRMED, "failed"]]);
  });

  it("an already-SENT row records nothing (a no-op delivery is not a send)", async () => {
    const calls: Recorded[] = [];
    const f = fakePort({ ...row, status: "SENT" });
    await applySend(f.port, f.mailer, "n1", (t, r) => calls.push([t, r]));
    expect(calls).toEqual([]);
  });

  it("a missing row records nothing", async () => {
    const calls: Recorded[] = [];
    const f = fakePort(null);
    await applySend(f.port, f.mailer, "x", (t, r) => calls.push([t, r]));
    expect(calls).toEqual([]);
  });
});
