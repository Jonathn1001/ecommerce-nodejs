import { describe, it, expect } from "vitest";
import { createMetrics } from "@ecom/shared";
import { createReservationMetrics } from "../metrics";

describe("reservation metrics", () => {
  it("counts each outcome under its own label", async () => {
    const m = createMetrics("inventory");
    const r = createReservationMetrics(m.registry);

    r.observe("RESERVED");
    r.observe("FAILED");
    r.observe("DUPLICATE");

    const out = await m.registry.metrics();
    // Label-order-independent: setDefaultLabels appends service= to every sample,
    // so never pin the closing brace of a sample line.
    expect(out).toMatch(/reservation_outcomes_total\{[^}]*outcome="RESERVED"[^}]*\} 1/);
    expect(out).toMatch(/reservation_outcomes_total\{[^}]*outcome="FAILED"[^}]*\} 1/);
    expect(out).toMatch(/reservation_outcomes_total\{[^}]*outcome="DUPLICATE"[^}]*\} 1/);
  });
});
