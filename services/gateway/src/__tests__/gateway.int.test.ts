import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "http";
import { generateKeyPairSync } from "crypto";
import { AddressInfo } from "net";
import request from "supertest";
import jwt from "jsonwebtoken";
import type express from "express";
import { createApp, type GatewayDeps } from "../app";
import type { GrantsCache } from "../grants-cache";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const sign = (sub: string, role: string) =>
  jwt.sign({ sub, role }, privateKey, { algorithm: "RS256", expiresIn: "5m" });

// One stub stands in for every upstream: two services can never share a Vitest process, so
// the real ones are exercised by the compose runbook instead.
function startStub(): Promise<{ server: Server; url: string; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    seen.push(`${req.method} ${url}`);

    if (url.startsWith("/slow")) return; // never answers -> exercises the timeout

    if (url.includes("/stream")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('event: status\ndata: {"n":1}\n\n');
      setTimeout(() => res.write('event: status\ndata: {"n":2}\n\n'), 150);
      setTimeout(() => res.end(), 400);
      return;
    }

    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      // Echo what the upstream actually received, so header hygiene is observable.
      res.end(
        JSON.stringify({
          path: url,
          userId: req.headers["x-user-id"] ?? null,
          role: req.headers["x-user-role"] ?? null,
          body: body || null,
        })
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, seen });
    });
  });
}

function fakeGrants(snapshot: Record<string, Record<string, string[]>>): GrantsCache {
  return {
    get: () => snapshot,
    refresh: async () => {},
    stop: () => {},
    ready: () => true,
  };
}

describe("gateway (integration — stub upstream)", () => {
  let stub: Awaited<ReturnType<typeof startStub>>;
  let app: express.Application;

  const build = (over: Partial<GatewayDeps> = {}) =>
    createApp({
      publicKey,
      upstreams: {
        identity: stub.url,
        order: stub.url,
        catalog: stub.url,
        payment: stub.url,
      },
      grants: fakeGrants({
        ADMIN: { "catalog.product": ["create", "update"], "payment.refund": ["create"] },
        USER: {},
      }),
      cookieSecure: false,
      breaker: { timeoutMs: 300, resetMs: 10_000 },
      ...over,
    });

  beforeAll(async () => {
    stub = await startStub();
    app = build();
  });
  afterAll(() => {
    stub.server.close();
  });

  describe("identity hygiene", () => {
    it("strips a forged x-user-id so it never reaches the upstream", async () => {
      const res = await request(app)
        .get("/products")
        .set("x-user-id", "attacker")
        .set("x-user-role", "ADMIN")
        .expect(200);
      expect(res.body.userId).toBeNull();
      expect(res.body.role).toBeNull();
    });

    it("injects the verified identity from a valid token", async () => {
      const res = await request(app)
        .get("/orders")
        .set("Authorization", `Bearer ${sign("u1", "USER")}`)
        .expect(200);
      expect(res.body.userId).toBe("u1");
      expect(res.body.role).toBe("USER");
    });

    it("accepts the token from the access_token cookie too", async () => {
      const res = await request(app)
        .get("/orders")
        .set("Cookie", [`access_token=${sign("u2", "USER")}`])
        .expect(200);
      expect(res.body.userId).toBe("u2");
    });

    it("401s a protected route with no token, a garbage token, or one signed by another key", async () => {
      await request(app).get("/orders").expect(401);
      await request(app).get("/orders").set("Authorization", "Bearer nope").expect(401);
      const other = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      const forged = jwt.sign({ sub: "u1", role: "ADMIN" }, other.privateKey, {
        algorithm: "RS256",
      });
      await request(app)
        .get("/orders")
        .set("Authorization", `Bearer ${forged}`)
        .expect(401);
    });
  });

  describe("authorization", () => {
    it("a USER cannot create a product, an ADMIN can", async () => {
      await request(app)
        .post("/products")
        .set("Authorization", `Bearer ${sign("u1", "USER")}`)
        .set("Cookie", ["XSRF-TOKEN=t"])
        .set("X-CSRF-Token", "t")
        .send({ name: "x" })
        .expect(403);

      await request(app)
        .post("/products")
        .set("Authorization", `Bearer ${sign("admin", "ADMIN")}`)
        .set("Cookie", ["XSRF-TOKEN=t"])
        .set("X-CSRF-Token", "t")
        .send({ name: "x" })
        .expect(200);
    });

    it("an unlisted route needs authentication only", async () => {
      await request(app)
        .get("/orders/o1")
        .set("Authorization", `Bearer ${sign("u1", "USER")}`)
        .expect(200);
    });

    it("browsing the catalog is public", async () => {
      await request(app).get("/products").expect(200);
    });

    it("a protected mutation with no token is 401, not 403", async () => {
      await request(app)
        .post("/products")
        .set("Cookie", ["XSRF-TOKEN=t"])
        .set("X-CSRF-Token", "t")
        .send({})
        .expect(401);
    });
  });

  describe("CSRF", () => {
    it("rejects a mutation with no CSRF header and accepts a matching one", async () => {
      const auth = `Bearer ${sign("admin", "ADMIN")}`;
      await request(app)
        .post("/products")
        .set("Authorization", auth)
        .send({})
        .expect(403);
      await request(app)
        .post("/products")
        .set("Authorization", auth)
        .set("Cookie", ["XSRF-TOKEN=abc"])
        .set("X-CSRF-Token", "wrong")
        .send({})
        .expect(403);
      await request(app)
        .post("/products")
        .set("Authorization", auth)
        .set("Cookie", ["XSRF-TOKEN=abc"])
        .set("X-CSRF-Token", "abc")
        .send({})
        .expect(200);
    });

    it("exempts the auth entry points and the payment webhook", async () => {
      await request(app)
        .post("/auth/login")
        .send({ email: "a@b.test", password: "x" })
        .expect((r) => expect(r.status).not.toBe(403));
      await request(app).post("/webhooks/payment").send({}).expect(200);
    });

    it("does not challenge safe methods", async () => {
      await request(app).get("/products").expect(200);
    });
  });

  describe("resilience", () => {
    it("times out a hanging upstream with 504, then opens the breaker (503)", async () => {
      const local = build({ breaker: { timeoutMs: 150, resetMs: 10_000 } });
      const auth = `Bearer ${sign("u1", "USER")}`;
      for (let i = 0; i < 4; i++)
        await request(local).get("/orders/slow").set("Authorization", auth);
      const res = await request(local).get("/orders/slow").set("Authorization", auth);
      expect([503, 504]).toContain(res.status);
      expect(res.status).toBe(503); // the circuit is open by now — upstream never touched
    }, 20_000);
  });

  describe("SSE pass-through", () => {
    it("streams frames incrementally instead of buffering to the end", async () => {
      const server = build().listen(0);
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/orders/o1/stream`, {
        headers: { Authorization: `Bearer ${sign("u1", "USER")}` },
      });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(res.headers.get("x-accel-buffering")).toBe("no");

      const reader = res.body!.getReader();
      const first = await reader.read();
      const firstAt = Date.now();
      const second = await reader.read();
      const gap = Date.now() - firstAt;

      const decode = (v?: Uint8Array) => new TextDecoder().decode(v);
      expect(decode(first.value)).toContain('"n":1');
      expect(decode(second.value)).toContain('"n":2');
      // The second frame arrives ~150ms later: proof the stream was not buffered whole.
      expect(gap).toBeGreaterThan(50);
      await reader.cancel();
      server.close();
    }, 20_000);

    it("401s an unauthenticated stream before touching the upstream", async () => {
      await request(app).get("/orders/o1/stream").expect(401);
    });
  });
});
