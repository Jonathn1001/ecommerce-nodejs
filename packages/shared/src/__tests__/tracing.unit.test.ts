import { describe, it, expect, vi, afterEach } from "vitest";

describe("tracing bootstrap", () => {
  afterEach(() => {
    // Leave both the mock registry and the module cache clean: the next test's
    // plain `import("../tracing")` (no resetModules of its own) must see a truly
    // fresh, unmocked evaluation, not the cached instance built under the mock.
    vi.doUnmock("node:worker_threads");
    vi.resetModules();
  });

  it("does not start the SDK on a non-main thread (e.g. tsx's own transform worker)", async () => {
    // Fix round 1: tsx's --import hook itself uses a worker_threads.Worker
    // internally (its esbuild transform service), and because NODE_OPTIONS still
    // points at this file, that worker evaluates it too — on a thread that will
    // never carry a single span. A probe against the real preload mechanism
    // (see task-2-report.md) found this module logging tracing_started from
    // inside that worker. Starting a real SDK/exporter there is unreachable
    // dead weight for the process's lifetime, so start() must bail out before
    // touching any guard state when it isn't the main thread.
    vi.doMock("node:worker_threads", () => ({ isMainThread: false, threadId: 7 }));
    // Start from a clean slate: a prior test in this file may already have set
    // this via a real (main-thread) import, and that must not mask a broken skip.
    globalThis.__ecomTracingStarted__ = undefined;

    vi.resetModules();
    const mod = await import("../tracing");

    expect(mod.tracingStarted()).toBe(false);
    expect(globalThis.__ecomTracingStarted__).not.toBe(true);
  });

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
