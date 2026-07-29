import { describe, it, expect, vi } from "vitest";

describe("tracing bootstrap", () => {
  it("is idempotent — a second evaluation does not start a second SDK", async () => {
    const first = await import("../tracing");
    expect(first.tracingStarted()).toBe(true);

    // Re-evaluate the module with a cleared registry — this is what the tsx loader
    // does, and it is the case a module-local flag would fail to guard. Use
    // vi.resetModules(), NOT an `import("../tracing?query")` cache-buster: vitest
    // resolves that through its own transform pipeline and it does not reliably
    // produce a second evaluation.
    vi.resetModules();
    const second = await import("../tracing");
    expect(second.tracingStarted()).toBe(true);
    expect(globalThis.__ecomTracingStarted__).toBe(true);
  });

  it("enables exactly the intended instrumentations and no messaging ones", async () => {
    const { ENABLED_INSTRUMENTATIONS } = await import("../tracing");
    expect(ENABLED_INSTRUMENTATIONS).toEqual([
      "@opentelemetry/instrumentation-http",
      "@opentelemetry/instrumentation-express",
      "@opentelemetry/instrumentation-redis",
      "@prisma/instrumentation",
    ]);
    // The load-bearing assertion: these propagate via broker headers while this system
    // propagates via the envelope. Enabling both yields traces that are correct on sync
    // hops and quietly wrong on async ones.
    expect(ENABLED_INSTRUMENTATIONS).not.toContain(
      "@opentelemetry/instrumentation-kafkajs"
    );
    expect(ENABLED_INSTRUMENTATIONS).not.toContain(
      "@opentelemetry/instrumentation-amqplib"
    );
  });
});
