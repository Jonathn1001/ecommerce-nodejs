import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { generateKeyPairSync } from "crypto";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import jwt from "jsonwebtoken";
import { createMetrics } from "@ecom/shared";
import { createApp, type GatewayDeps } from "../app";
import type { GrantsCache } from "../grants-cache";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const sign = (sub: string, role: string) =>
  jwt.sign({ sub, role }, privateKey, { algorithm: "RS256", expiresIn: "5m" });

function fakeGrants(): GrantsCache {
  return {
    get: () => ({}),
    refresh: async () => {},
    stop: () => {},
    ready: () => true,
  };
}

describe("gateway metrics", () => {
  it("labels a proxy mount by the mount and its upstream, never the raw path", async () => {
    const m = createMetrics("gateway");
    const app = express().use(m.httpMiddleware());
    app.use("/orders", (_req, res) => {
      res.locals.metricsRoute = "/orders";
      res.locals.metricsUpstream = "order";
      res.json({ ok: true });
    });
    app.use(m.router());

    await request(app).get("/orders/abc-123/items");
    const out = await m.registry.metrics();

    expect(out).toContain('route="/orders"');
    expect(out).toContain('upstream="order"');
    expect(out).not.toContain("abc-123");
  });

  it("does not mount /metrics on the main app — the scrape surface lives on METRICS_PORT only", async () => {
    // Deps construction mirrors gateway.int.test.ts's `build()`: the real createApp with the
    // minimal GatewayDeps it needs to boot. No upstream calls happen here since the request
    // never matches a mounted route.
    const deps: GatewayDeps = {
      publicKey,
      upstreams: {
        identity: "http://127.0.0.1:1",
        order: "http://127.0.0.1:1",
        catalog: "http://127.0.0.1:1",
        payment: "http://127.0.0.1:1",
      },
      grants: fakeGrants(),
      cookieSecure: false,
      breaker: { timeoutMs: 300, resetMs: 10_000 },
    };
    const app = createApp(deps);

    await request(app).get("/metrics").expect(404);
  });

  describe("guard() wiring on a real proxy mount", () => {
    let stub: Server;
    let stubUrl: string;

    beforeAll(async () => {
      stub = createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ path: req.url }));
      });
      await new Promise<void>((resolve) => stub.listen(0, resolve));
      const { port } = stub.address() as AddressInfo;
      stubUrl = `http://127.0.0.1:${port}`;
    });
    afterAll(() => {
      stub.close();
    });

    it("records the RED metric for a proxied request under the mount, not the raw upstream path", async () => {
      const metrics = createMetrics("gateway-guard-test");
      const app = createApp({
        publicKey,
        upstreams: {
          identity: stubUrl,
          order: stubUrl,
          catalog: stubUrl,
          payment: stubUrl,
        },
        grants: fakeGrants(),
        cookieSecure: false,
        breaker: { timeoutMs: 300, resetMs: 10_000 },
        metrics,
      });

      await request(app)
        .get("/orders/abc-123/items")
        .set("Authorization", `Bearer ${sign("u1", "USER")}`)
        .expect(200);

      const out = await metrics.registry.metrics();
      expect(out).toContain('route="/orders"');
      expect(out).toContain('upstream="order"');
      expect(out).not.toContain("abc-123");
    });
  });
});
