import type { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { trace, context } from "@opentelemetry/api";
import { createLogger } from "./logger";

export const TRACE_HEADER = "x-trace-id";
const log = createLogger("http");

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      traceId: string;
    }
  }
}

// The active span's trace id IS the traceId now, so a log line pastes straight into
// Jaeger. With no active span — every test run, and any service started without the
// NODE_OPTIONS preload — fall back to the old uuid so nothing that works today stops.
function activeTraceId(): string | undefined {
  const sc = trace.getSpanContext(context.active());
  return sc && sc.traceId !== "00000000000000000000000000000000" ? sc.traceId : undefined;
}

export function currentTraceparent(): string | undefined {
  const sc = trace.getSpanContext(context.active());
  if (!sc || sc.traceId === "00000000000000000000000000000000") return undefined;
  return `00-${sc.traceId}-${sc.spanId}-${sc.traceFlags.toString(16).padStart(2, "0")}`;
}

export function traceMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header(TRACE_HEADER);
    // Precedence: the active span (established by the http instrumentation, which has
    // already extracted any inbound W3C `traceparent`) > the legacy x-trace-id header >
    // a fresh uuid. x-trace-id stays supported so external callers keep working.
    const traceId =
      activeTraceId() ?? (incoming && incoming.length > 0 ? incoming : uuidv4());
    req.traceId = traceId;
    res.setHeader(TRACE_HEADER, traceId);
    // Metadata only — method, path, traceId. NEVER body or query values.
    log.info("http_request", { method: req.method, path: req.path, traceId });
    next();
  };
}
