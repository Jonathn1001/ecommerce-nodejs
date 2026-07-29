import { describe, it, expect } from "vitest";
import { createMetrics } from "@ecom/shared";
import { ORDER_CONFIRMED } from "@ecom/contracts";
import { createNotificationMetrics } from "../metrics";

describe("notification metrics", () => {
  it("counts sends by template type and result", async () => {
    const m = createMetrics("notification");
    const n = createNotificationMetrics(m.registry);
    n.observe(ORDER_CONFIRMED, "sent");
    n.observe(ORDER_CONFIRMED, "failed");
    const out = await m.registry.metrics();
    // Label-order-independent: setDefaultLabels appends service= to every sample,
    // so never pin the closing brace of a sample line. ORDER_CONFIRMED is used
    // rather than a hand-typed string so the label can never drift from the contract.
    const type = ORDER_CONFIRMED.replace(/\./g, "\\.");
    expect(out).toMatch(
      new RegExp(`notifications_sent_total\\{[^}]*type="${type}"[^}]*\\} 1`)
    );
    expect(out).toMatch(/notifications_sent_total\{[^}]*result="sent"[^}]*\} 1/);
    expect(out).toMatch(/notifications_sent_total\{[^}]*result="failed"[^}]*\} 1/);
  });
});
