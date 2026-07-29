import { describe, it, expect } from "vitest";
import { createMetrics } from "@ecom/shared";
import { createPaymentMetrics } from "../metrics";

describe("payment metrics", () => {
  it("counts attempts by outcome", async () => {
    const m = createMetrics("payment");
    const p = createPaymentMetrics(m.registry);
    p.observe("succeeded");
    p.observe("processing");
    const out = await m.registry.metrics();
    // Label-order-independent: setDefaultLabels appends service= to every sample,
    // so never pin the closing brace of a sample line.
    expect(out).toMatch(/payment_attempts_total\{[^}]*outcome="succeeded"[^}]*\} 1/);
    expect(out).toMatch(/payment_attempts_total\{[^}]*outcome="processing"[^}]*\} 1/);
  });
});
