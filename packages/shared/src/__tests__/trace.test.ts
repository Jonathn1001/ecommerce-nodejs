import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { traceMiddleware, TRACE_HEADER } from "../trace";

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
      ["level", "message", "method", "path", "service", "timestamp", "traceId"].sort(),
    );
    expect(parsed.path).toBe("/checkout");
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("user@example.com");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("SECRET50");
  });
});
