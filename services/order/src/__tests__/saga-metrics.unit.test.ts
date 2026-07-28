import { describe, it, expect } from "vitest";
import { createMetrics } from "@ecom/shared";
import { createSagaMetrics } from "../metrics";

describe("saga metrics", () => {
  it("observes step and total duration with the expected labels", async () => {
    const m = createMetrics("order");
    const saga = createSagaMetrics(m.registry);

    saga.observeStep("reserve", 0.4);
    saga.observeSaga("confirmed", 1.2);

    const out = await m.registry.metrics();
    // prom-client alphabetizes labels (le, service, step/outcome), so a fixed-order
    // substring match on "{step=..." would never hold; match the bucket line and
    // label independently instead.
    expect(out).toMatch(/saga_step_duration_seconds_bucket\{[^}]*step="reserve"[^}]*\}/);
    expect(out).toMatch(/saga_duration_seconds_bucket\{[^}]*outcome="confirmed"[^}]*\}/);
  });
});

import { setSagaMetrics } from "../consumer";
import { INVENTORY_RESERVED } from "@ecom/contracts";

describe("saga metrics gating", () => {
  it("records nothing for a NO_OP outcome", async () => {
    const m = createMetrics("order");
    const seen: string[] = [];
    setSagaMetrics({
      observeStep: (step) => seen.push(`step:${step}`),
      observeSaga: (outcome) => seen.push(`saga:${outcome}`),
    });

    // A lost compare-and-set returns NO_OP from applyResult; the caller must not record.
    // Drive applyResult directly with a fake tx whose setStatus returns false.
    const { applyResult } = await import("../transition");
    const outcome = await applyResult(
      {
        loadOrder: async () => ({ status: "PENDING", totalPrice: 100, userId: "u1" }),
        markProcessed: async () => true,
        setStatus: async () => false, // lost CAS
        enqueue: async () => {},
        notify: async () => {},
      },
      { eventId: "e1", type: INVENTORY_RESERVED, orderId: "o1" }
    );

    expect(outcome).toBe("NO_OP");
    expect(seen).toEqual([]);
    expect(await m.registry.metrics()).not.toContain("saga_duration_seconds_count");
  });
});
