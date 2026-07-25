import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { traceMiddleware, createLogger, createHealthRouter } from "@ecom/shared";
import { authenticate, stripIdentityHeaders } from "./auth-middleware";
import { authorize } from "./authz";
import { csrfGuard } from "./csrf";
import { setSessionCookies, clearSessionCookies, REFRESH_COOKIE } from "./cookies";
import { createUpstreamProxy, createStreamProxy, guardWithBreaker } from "./proxy";
import type { GrantsCache } from "./grants-cache";

const log = createLogger("gateway");

export type Upstreams = {
  identity: string;
  order: string;
  catalog: string;
  payment: string;
};

export type GatewayDeps = {
  publicKey: string;
  upstreams: Upstreams;
  grants: GrantsCache;
  cookieSecure: boolean;
  breaker: { timeoutMs: number; resetMs: number };
  fetchImpl?: typeof fetch;
};

// No CSRF token exists yet at the auth entry points, and the payment webhook is a
// server-to-server callback with no cookie session to abuse.
const CSRF_EXEMPT = [/^\/auth\/(login|register|refresh)$/, /^\/webhooks\/payment$/];

export function createApp(deps: GatewayDeps): express.Application {
  const app = express();
  const doFetch = deps.fetchImpl ?? fetch;

  app.use(helmet());
  app.use(cookieParser());
  app.use(traceMiddleware());
  // FIRST, always: a client must not be able to hand a service an identity.
  app.use(stripIdentityHeaders());

  app.use(
    createHealthRouter({
      // Readiness means "we can authorize" — deliberately NOT upstream reachability, or one
      // sick service would take the whole edge out of rotation. That is the breaker's job.
      grants: async () => {
        if (!deps.grants.ready()) throw new Error("grants snapshot not loaded");
      },
    })
  );

  const authLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true });
  const generalLimiter = rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: true,
  });
  app.use(generalLimiter);

  app.use(csrfGuard(CSRF_EXEMPT));

  // ---- auth: the gateway owns the cookie translation, identity owns the credentials ----
  app.post("/auth/login", authLimiter, express.json(), async (req, res) => {
    try {
      const r = await doFetch(`${deps.upstreams.identity}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req.body ?? {}),
      });
      const body = (await r.json()) as { accessToken?: string; refreshToken?: string };
      if (!r.ok || !body.accessToken || !body.refreshToken)
        return res.status(r.status === 200 ? 502 : r.status).json(body);
      setSessionCookies(res, body as { accessToken: string; refreshToken: string }, {
        secure: deps.cookieSecure,
      });
      return res.status(200).json({ ok: true });
    } catch {
      log.error("login_proxy_failed", { traceId: req.traceId });
      return res.status(502).json({ error: "identity unavailable" });
    }
  });

  app.post("/auth/register", authLimiter, express.json(), async (req, res) => {
    try {
      const r = await doFetch(`${deps.upstreams.identity}/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req.body ?? {}),
      });
      return res.status(r.status).json(await r.json());
    } catch {
      log.error("register_proxy_failed", { traceId: req.traceId });
      return res.status(502).json({ error: "identity unavailable" });
    }
  });

  // The browser holds the refresh token in an httpOnly cookie; identity wants it in a body.
  // That translation lives here, and a rejection clears every cookie so a reuse-detected
  // client lands back at login instead of retrying a dead token.
  app.post("/auth/refresh", authLimiter, async (req, res) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!token) return res.status(401).json({ error: "unauthenticated" });
    try {
      const r = await doFetch(`${deps.upstreams.identity}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: token }),
      });
      if (!r.ok) {
        clearSessionCookies(res);
        return res.status(401).json({ error: "unauthenticated" });
      }
      const body = (await r.json()) as { accessToken: string; refreshToken: string };
      setSessionCookies(res, body, { secure: deps.cookieSecure });
      return res.status(200).json({ ok: true });
    } catch {
      log.error("refresh_proxy_failed", { traceId: req.traceId });
      return res.status(502).json({ error: "identity unavailable" });
    }
  });

  app.post("/auth/logout", async (req, res) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (token) {
      try {
        await doFetch(`${deps.upstreams.identity}/auth/logout`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: token }),
        });
      } catch {
        log.error("logout_proxy_failed", { traceId: req.traceId });
      }
    }
    clearSessionCookies(res);
    return res.status(204).end();
  });

  // ---- proxied surface ----
  const guard = (name: string, target: string) =>
    guardWithBreaker(name, createUpstreamProxy(target), deps.breaker);

  const authRequired = authenticate(deps.publicKey, { required: true });
  const authOptional = authenticate(deps.publicKey, { required: false });
  const authz = authorize(deps.grants);

  // SSE: authenticated, but exempt from breaker + timeout (see proxy.ts).
  app.get("/orders/:id/stream", authRequired, createStreamProxy(deps.upstreams.order));

  app.use("/cart", authRequired, authz, guard("order", deps.upstreams.order));
  app.use("/orders", authRequired, authz, guard("order", deps.upstreams.order));
  // Browsing the catalog is public; mutating it is not (authz decides from the rules table).
  app.use("/products", authOptional, authz, guard("catalog", deps.upstreams.catalog));
  app.use("/comments", authOptional, authz, guard("catalog", deps.upstreams.catalog));
  app.use("/discounts", authOptional, authz, guard("catalog", deps.upstreams.catalog));
  app.use("/payments", authRequired, authz, guard("payment", deps.upstreams.payment));
  app.use(
    "/admin/payments",
    authRequired,
    authz,
    guard("payment", deps.upstreams.payment)
  );
  // Provider callback: no session, no CSRF, no auth — but it must stay reachable once the
  // prod profile closes payment's own port.
  app.use("/webhooks/payment", guard("payment", deps.upstreams.payment));

  return app;
}
