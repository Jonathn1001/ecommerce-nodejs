import { describe, it, expect, vi } from "vitest";
import { createMetrics } from "../metrics";

describe("startDlqPoller", () => {
  it("sets the gauge from the probe", async () => {
    const m = createMetrics("payment");
    const poller = m.startDlqPoller(async () => 7, ["payment.charge.dlq"], {
      intervalMs: 5,
    });

    await vi.waitFor(async () =>
      expect(await m.registry.metrics()).toContain(
        'rabbitmq_dlq_depth{queue="payment.charge.dlq"} 7'
      )
    );
    poller.stop();
  });

  it("survives a rejecting probe and keeps polling", async () => {
    const m = createMetrics("payment");
    let calls = 0;
    const probe = async () => {
      calls += 1;
      if (calls < 3) throw new Error("channel closed");
      return 2;
    };
    const poller = m.startDlqPoller(probe, ["payment.charge.dlq"], { intervalMs: 5 });

    await vi.waitFor(async () =>
      expect(await m.registry.metrics()).toContain(
        'rabbitmq_dlq_depth{queue="payment.charge.dlq"} 2'
      )
    );
    poller.stop();
  });

  it("stop() halts further probing", async () => {
    const m = createMetrics("payment");
    let calls = 0;
    const poller = m.startDlqPoller(
      async () => {
        calls += 1;
        return 1;
      },
      ["q.dlq"],
      { intervalMs: 5 }
    );

    await vi.waitFor(() => expect(calls).toBeGreaterThan(0));
    poller.stop();
    const seen = calls;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(seen);
  });
});
