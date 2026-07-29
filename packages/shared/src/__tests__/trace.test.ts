import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { context, trace, SpanContext, TraceFlags } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { traceMiddleware, TRACE_HEADER, currentTraceparent } from "../trace";

// @opentelemetry/api's default ContextManager (used whenever nothing has called
// context.setGlobalContextManager) is a no-op: `context.with(ctx, fn)` just calls
// `fn()` without ever making `ctx` the active context, so `context.active()` inside
// `fn` would keep returning the empty ROOT_CONTEXT no matter what was passed to
// `.with()`. A real ContextManager has to be registered for the "active span" tests
// below to mean anything. Production processes get one for free from tracing.ts's
// NodeSDK.start() (Task 2's preload); this test file has none of that, so it
// registers its own tracer provider — test-only setup. `trace.ts` itself must stay
// a side-effect-free library import (see Task 2's index.ts boundary note), so this
// does NOT belong there. @opentelemetry/sdk-trace-node is already a devDependency
// (added in Task 2 for the later relay/kafka/rabbit span tests), so nothing new
// needs installing. Registering twice in the same process is already relied on
// elsewhere in this suite (tracing.unit.test.ts's idempotency test re-runs
// sdk.start() after a module reset) and is harmless: @opentelemetry/api logs and
// ignores a duplicate registration rather than throwing.
new NodeTracerProvider().register();

// Winston's Console transport writes via `console._stdout.write(...)`, and
// under Vitest `console._stdout` is Vitest's own capture stream, not
// `process.stdout` (see logger.test.ts for the full explanation). Spy on the
// stream winston actually writes to so we can inspect the emitted JSON.
const stdoutStream = (console as unknown as { _stdout: NodeJS.WriteStream })._stdout;

function app() {
  const a = express();
  a.use(traceMiddleware());
  a.get("/", (req, res) => res.json({ traceId: (req as any).traceId }));
  return a;
}

describe("traceMiddleware", () => {
  it("mints a traceId when none is provided and echoes it", async () => {
    const res = await request(app()).get("/");
    expect(res.body.traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers[TRACE_HEADER]).toBe(res.body.traceId);
  });

  it("reuses an incoming x-trace-id", async () => {
    const res = await request(app()).get("/").set(TRACE_HEADER, "abc-123");
    expect(res.body.traceId).toBe("abc-123");
    expect(res.headers[TRACE_HEADER]).toBe("abc-123");
  });

  it("logs only method, path, and traceId — never request body or query values", async () => {
    const spy = vi.spyOn(stdoutStream, "write").mockImplementation(() => true);
    const a = express();
    a.use(express.json());
    a.use(traceMiddleware());
    a.post("/checkout", (req, res) => res.json({ ok: true }));

    await request(a)
      .post("/checkout?promo=SECRET50")
      .send({ email: "user@example.com", password: "hunter2" });

    const line = spy.mock.calls.map((c) => String(c[0])).join("");
    spy.mockRestore();
    const parsed = JSON.parse(line);

    // Output surface is exactly {level, message, service, timestamp, method,
    // path, traceId} — no body fields, no query string, nothing else leaks in.
    expect(Object.keys(parsed).sort()).toEqual(
      ["level", "message", "method", "path", "service", "timestamp", "traceId"].sort()
    );
    expect(parsed.path).toBe("/checkout");
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("user@example.com");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("SECRET50");
  });
});

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

function withSpan<T>(fn: () => T): T {
  const sc: SpanContext = {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false,
  };
  const ctx = trace.setSpanContext(context.active(), sc);
  return context.with(ctx, fn);
}

describe("traceId derives from the active span", () => {
  it("uses the active span's trace id, not a fresh uuid", () => {
    const req = { header: () => undefined, method: "GET", path: "/x" } as never;
    const res = { setHeader: () => {} } as never;
    withSpan(() => traceMiddleware()(req, res, () => {}));
    expect((req as { traceId: string }).traceId).toBe(TRACE_ID);
  });

  it("falls back to a uuid when there is no active span (every test run)", () => {
    const req = { header: () => undefined, method: "GET", path: "/x" } as never;
    const res = { setHeader: () => {} } as never;
    traceMiddleware()(req, res, () => {});
    expect((req as { traceId: string }).traceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("prefers the active span's trace id over a simultaneously-present x-trace-id header", () => {
    const HEADER_TRACE_ID = "legacy-header-should-lose";
    const req = { header: () => HEADER_TRACE_ID, method: "GET", path: "/x" } as never;
    const res = { setHeader: () => {} } as never;
    withSpan(() => traceMiddleware()(req, res, () => {}));
    expect((req as { traceId: string }).traceId).toBe(TRACE_ID);
    expect((req as { traceId: string }).traceId).not.toBe(HEADER_TRACE_ID);
  });

  it("currentTraceparent serializes the active span context", () => {
    expect(withSpan(() => currentTraceparent())).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
  });

  it("currentTraceparent is undefined with no active span", () => {
    expect(currentTraceparent()).toBeUndefined();
  });
});
