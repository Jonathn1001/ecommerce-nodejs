import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, request as httpRequest, type Server } from "http";
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

    if (url.includes("/slow")) return; // never answers -> exercises the timeout

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
          trace: req.headers["x-trace-id"] ?? null,
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
        ADMIN: {
          "catalog.product": ["create", "update"],
          "payment.refund": ["create"],
          "catalog.comment": ["delete"],
        },
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

  describe("path fidelity (regression: the mount prefix was being dropped)", () => {
    // Express trims req.url inside app.use(), and http-proxy-middleware v3 no longer
    // restores it — so every proxied route reached the upstream stripped ("/abc" for
    // "/orders/abc") and 404ed in real life while the suite stayed green, because nothing
    // asserted the path the upstream actually received.
    it("forwards the FULL path, not the mount-relative remainder", async () => {
      const auth = `Bearer ${sign("u1", "USER")}`;
      const get = async (path: string) =>
        (await request(app).get(path).set("Authorization", auth)).body.path;
      expect(await get("/orders/o1")).toBe("/orders/o1");
      expect(await get("/cart")).toBe("/cart");
      expect(await get("/products/p1")).toBe("/products/p1");

      const posted = await request(app)
        .post("/cart/items")
        .set("Authorization", auth)
        .set("Cookie", ["XSRF-TOKEN=t"])
        .set("X-CSRF-Token", "t")
        .send({ productId: "p1", quantity: 1 });
      expect(posted.body.path).toBe("/cart/items");

      const webhook = await request(app).post("/webhooks/payment").send({});
      expect(webhook.body.path).toBe("/webhooks/payment");

      const refund = await request(app)
        .post("/admin/payments/o1/refund")
        .set("Authorization", `Bearer ${sign("admin", "ADMIN")}`)
        .set("Cookie", ["XSRF-TOKEN=t"])
        .set("X-CSRF-Token", "t")
        .send({});
      expect(refund.body.path).toBe("/admin/payments/o1/refund");
    });

    it("preserves the query string", async () => {
      const res = await request(app).get("/products?limit=2");
      expect(res.body.path).toBe("/products?limit=2");
    });

    it("forwards the trace id so one request keeps one trace across hops", async () => {
      const res = await request(app).get("/products").set("x-trace-id", "trace-abc");
      expect(res.body.trace).toBe("trace-abc");
    });
  });

  describe("path normalisation (regression: case variants bypassed authz)", () => {
    // Express matches mounts case-insensitively and the RBAC table was case-SENSITIVE, so
    // `POST /Products` matched no rule, skipped authentication entirely on the optional-auth
    // mount, and still reached catalog — which also matches case-insensitively.
    it("refuses a case-varied protected route instead of forwarding it", async () => {
      const res = await request(app)
        .post("/Products")
        .set("Cookie", ["XSRF-TOKEN=t"])
        .set("X-CSRF-Token", "t")
        .send({});
      expect(res.status).not.toBe(200);
      expect(res.body.path).toBeUndefined(); // never reached the upstream
    });

    it("does not let a case-varied refund through as a plain USER", async () => {
      const res = await request(app)
        .post("/Admin/payments/o1/refund")
        .set("Authorization", `Bearer ${sign("u1", "USER")}`)
        .set("Cookie", ["XSRF-TOKEN=t"])
        .set("X-CSRF-Token", "t")
        .send({});
      expect(res.status).not.toBe(200);
    });

    it("rejects traversal attempts outright", async () => {
      // Raw socket, not supertest: superagent normalises "/a/../b" to "/b" client-side, so
      // the guard would never see the path an attacker actually sends.
      const server = build().listen(0);
      const { port } = server.address() as AddressInfo;
      const rawGet = (path: string) =>
        new Promise<number>((resolve, reject) => {
          const req = httpRequest(
            { host: "127.0.0.1", port, path, method: "GET" },
            (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            }
          );
          req.on("error", reject);
          req.end();
        });
      expect(await rawGet("/products/../products")).toBe(400);
      expect(await rawGet("/products/%2e%2e/products")).toBe(400);
      server.close();
    });
  });

  describe("mutating catalog surfaces require authentication", () => {
    it("an anonymous caller cannot delete a comment", async () => {
      const res = await request(app)
        .delete("/comments/c1")
        .set("Cookie", ["XSRF-TOKEN=t"])
        .set("X-CSRF-Token", "t");
      expect(res.status).toBe(401);
    });

    it("a USER cannot delete a comment; an ADMIN can", async () => {
      const send = (role: string) =>
        request(app)
          .delete("/comments/c1")
          .set("Authorization", `Bearer ${sign("u1", role)}`)
          .set("Cookie", ["XSRF-TOKEN=t"])
          .set("X-CSRF-Token", "t");
      expect((await send("USER")).status).toBe(403);
      expect((await send("ADMIN")).status).toBe(200);
    });

    it("an anonymous caller cannot apply a discount", async () => {
      const res = await request(app)
        .post("/discounts/code/apply")
        .set("Cookie", ["XSRF-TOKEN=t"])
        .set("X-CSRF-Token", "t")
        .send({ userId: "someone-else" });
      expect(res.status).toBe(401);
    });
  });

  describe("rate limiting", () => {
    it("throttles the auth surface (credential stuffing) at 10/min", async () => {
      // Its own app instance: the limiter is keyed by IP, so sharing one with the other
      // tests would make this depend on how many auth calls they happened to make first.
      const local = build();
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const res = await request(local)
          .post("/auth/login")
          .send({ email: "a@b.test", password: "x" });
        statuses.push(res.status);
      }
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
      expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    }, 20_000);

    it("does not throttle ordinary browsing at the auth rate", async () => {
      const local = build();
      for (let i = 0; i < 12; i++) await request(local).get("/products").expect(200);
    }, 20_000);
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
