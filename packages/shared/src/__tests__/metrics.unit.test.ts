import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createMetrics } from "../metrics";

describe("createMetrics", () => {
  it("stamps the service default label on every sample", async () => {
    const m = createMetrics("order");
    const app = express().use(m.httpMiddleware()).use(m.router());
    app.get("/ping", (_req, res) => res.json({ ok: true }));

    await request(app).get("/ping");
    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain('service="order"');
  });

  it("labels a mounted router by its FULL pattern, not the mount-relative one", async () => {
    const m = createMetrics("order");
    const router = express.Router();
    router.get("/:id", (_req, res) => res.json({ ok: true }));

    const app = express().use(m.httpMiddleware());
    app.use("/orders", router);
    app.use(m.router());

    await request(app).get("/orders/abc-123");
    const res = await request(app).get("/metrics");

    expect(res.text).toContain('route="/orders/:id"');
    expect(res.text).not.toContain('route="/:id"');
    expect(res.text).not.toContain("abc-123");
  });

  it("labels unmatched requests as unmatched, never the raw path", async () => {
    const m = createMetrics("order");
    const app = express().use(m.httpMiddleware()).use(m.router());

    await request(app).get("/nope/deadbeef");
    const res = await request(app).get("/metrics");

    expect(res.text).toContain('route="unmatched"');
    expect(res.text).not.toContain("deadbeef");
  });

  it("does not start a default-metrics collector unless asked", async () => {
    const m = createMetrics("order");
    const res = await m.registry.metrics();
    expect(res).not.toContain("process_cpu_seconds_total");
  });

  it("collects default metrics when opted in", async () => {
    const m = createMetrics("order", { defaultMetrics: true });
    const res = await m.registry.metrics();
    expect(res).toContain("process_cpu_seconds_total");
  });
});
