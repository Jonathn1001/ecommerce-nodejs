import type { Request, Response, NextFunction, RequestHandler } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import CircuitBreaker from "opossum";
import { createLogger } from "@ecom/shared";

const log = createLogger("gateway-proxy");

type Rejecter = (e: Error) => void;
type TaggedRequest = Request & { __proxyReject?: Rejecter };

export function createUpstreamProxy(target: string): RequestHandler {
  return createProxyMiddleware({
    target,
    changeOrigin: false,
    xfwd: true,
    on: {
      // Hand the failure to the breaker wrapper instead of writing a response here, so one
      // sick upstream actually trips its circuit.
      error: (err, req) => {
        (req as TaggedRequest).__proxyReject?.(err as Error);
      },
    },
  });
}

// Streaming pass-through: NO breaker and NO timeout. An opossum timeout would kill a
// perfectly healthy long-lived SSE stream after a few seconds — the failure mode this
// phase was explicitly warned about. Buffering is disabled so frames arrive as they are
// produced rather than at stream end.
export function createStreamProxy(target: string): RequestHandler {
  return createProxyMiddleware({
    target,
    changeOrigin: false,
    xfwd: true,
    on: {
      proxyReq: (proxyReq) => {
        proxyReq.setHeader("accept-encoding", "identity"); // no gzip buffering
      },
      proxyRes: (proxyRes) => {
        proxyRes.headers["cache-control"] = "no-cache";
        proxyRes.headers["x-accel-buffering"] = "no"; // nginx et al must not buffer either
        delete proxyRes.headers["content-length"];
      },
      error: (err, _req, res) => {
        const r = res as Response;
        if (!r.headersSent) r.status(502).json({ error: "stream upstream unavailable" });
        else r.end();
      },
    },
  });
}

// Wraps a proxy handler in a per-upstream circuit breaker. The action resolves when the
// response finishes and rejects when the proxy errors, so opossum sees real upstream health.
export function guardWithBreaker(
  name: string,
  handler: RequestHandler,
  opts: { timeoutMs: number; resetMs: number }
): RequestHandler {
  const breaker = new CircuitBreaker(
    (req: Request, res: Response) =>
      new Promise<void>((resolve, reject) => {
        (req as TaggedRequest).__proxyReject = reject;
        res.once("close", () => resolve());
        res.once("finish", () => resolve());
        handler(req, res, (err?: unknown) => (err ? reject(err as Error) : undefined));
      }),
    {
      timeout: opts.timeoutMs,
      resetTimeout: opts.resetMs,
      errorThresholdPercentage: 50,
      volumeThreshold: 3,
      name,
    }
  );

  breaker.on("open", () => log.error("breaker_open", { upstream: name }));
  breaker.on("halfOpen", () => log.info("breaker_half_open", { upstream: name }));
  breaker.on("close", () => log.info("breaker_closed", { upstream: name }));

  return (req: Request, res: Response, _next: NextFunction) => {
    breaker.fire(req, res).catch((e: Error & { code?: string }) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      // Open circuit -> 503 (we never touched the upstream). Timeout -> 504.
      if (e.code === "EOPENBREAKER" || breaker.opened) {
        res.status(503).json({ error: "upstream unavailable", upstream: name });
        return;
      }
      res.status(504).json({ error: "upstream timeout", upstream: name });
    });
  };
}
