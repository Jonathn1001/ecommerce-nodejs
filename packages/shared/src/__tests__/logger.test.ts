import { describe, it, expect, vi } from "vitest";
import { createLogger } from "../logger";

// Winston's Console transport writes via `console._stdout.write(...)`, and
// under Vitest `console._stdout` is Vitest's own capture stream, not
// `process.stdout` (they are different object references in-process, even
// though they are the same stream in a real process). Spy on the stream
// winston actually writes to.
const stdoutStream = (console as unknown as { _stdout: NodeJS.WriteStream })._stdout;

describe("createLogger", () => {
  it("emits JSON with service, level, message, and passed meta", () => {
    const spy = vi.spyOn(stdoutStream, "write").mockImplementation(() => true);
    const log = createLogger("hello");
    log.info("order_reserved", { orderId: "o1", traceId: "t1" });
    const line = spy.mock.calls.map((c) => String(c[0])).join("");
    spy.mockRestore();
    const parsed = JSON.parse(line);
    expect(parsed.service).toBe("hello");
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("order_reserved");
    expect(parsed.orderId).toBe("o1");
    expect(parsed.traceId).toBe("t1");
  });

  it("only emits fields the caller explicitly passed — ids/codes appear, nothing else is injected", () => {
    const spy = vi.spyOn(stdoutStream, "write").mockImplementation(() => true);
    const log = createLogger("orders");
    log.warn("order_flagged", { orderId: "o2", traceId: "t2" });
    const line = spy.mock.calls.map((c) => String(c[0])).join("");
    spy.mockRestore();
    const parsed = JSON.parse(line);
    // Output surface is exactly {service, level, message, timestamp, ...meta} -
    // no hidden defaults (env, headers, request body, etc.) ever leak in, so the
    // logger can only ever emit what a caller explicitly hands it (ids/codes).
    expect(Object.keys(parsed).sort()).toEqual(
      ["level", "message", "orderId", "service", "timestamp", "traceId"].sort(),
    );
  });
});
