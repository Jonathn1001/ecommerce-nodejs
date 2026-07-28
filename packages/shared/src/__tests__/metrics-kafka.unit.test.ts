import { describe, it, expect } from "vitest";
import { createMetrics } from "../metrics";

describe("kafka metric recorders", () => {
  it("records lag, outcomes and handler duration on the registry", async () => {
    const m = createMetrics("order");

    m.kafkaHooks.onBatch({ group: "g1", topic: "order.events", partition: "0", lag: 42 });
    m.kafkaHooks.onMessage({ group: "g1", topic: "order.events", result: "ok" });
    m.kafkaHooks.onMessage({ group: "g1", topic: "order.events", result: "dlq" });
    m.kafkaHooks.observeHandler({
      group: "g1",
      topic: "order.events",
      type: "order_placed",
      seconds: 0.2,
    });

    const out = await m.registry.metrics();
    // Label-order-independent: registry.setDefaultLabels appends service= to every
    // sample, so never pin the closing brace of a sample line.
    expect(out).toMatch(/kafka_consumer_lag\{[^}]*partition="0"[^}]*\} 42/);
    expect(out).toContain('result="dlq"');
    expect(out).toContain("kafka_handler_duration_seconds_bucket");
  });
});
