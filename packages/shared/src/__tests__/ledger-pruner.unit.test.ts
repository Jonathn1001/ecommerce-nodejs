import { describe, it, expect, vi } from "vitest";
import { startLedgerPruner, type LedgerPrunerPort } from "../ledger-pruner";

function fakePort() {
  const cutoffs: Date[] = [];
  const port: LedgerPrunerPort = {
    async deleteOlderThan(cutoff) {
      cutoffs.push(cutoff);
      return 3;
    },
  };
  return { port, cutoffs };
}

describe("startLedgerPruner", () => {
  it("prunes on the interval using a cutoff retentionDays in the past", async () => {
    vi.useFakeTimers();
    const f = fakePort();
    const pruner = startLedgerPruner(f.port, { retentionDays: 30, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.cutoffs).toHaveLength(1);
    const ageMs = Date.now() - f.cutoffs[0].getTime();
    expect(ageMs).toBeGreaterThanOrEqual(30 * 24 * 3600_000);
    pruner.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.cutoffs).toHaveLength(1); // stopped means stopped
    vi.useRealTimers();
  });

  it("a failing prune is logged and does not stop the timer", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const port: LedgerPrunerPort = {
      async deleteOlderThan() {
        calls++;
        throw new Error("db down");
      },
    };
    const pruner = startLedgerPruner(port, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toBeGreaterThanOrEqual(2);
    pruner.stop();
    vi.useRealTimers();
  });
});
