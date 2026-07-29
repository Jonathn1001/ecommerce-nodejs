// MUST come first: it plants JWT_PRIVATE_KEY before ../app validates its config.
import "./test-key";
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app";

// `.int` rather than a plain unit test, unlike the same test in six other services:
// identity's app.ts imports ./config at module scope, so merely importing createApp
// runs the config schema and needs DATABASE_URL. The quality CI lane runs with no
// database and no .env files, so this belongs in the integration lane, which exports
// it. (payment/src/__tests__/metrics.int.test.ts is the same case.)
describe("identity /metrics", () => {
  it("exposes prometheus metrics stamped with the service name", async () => {
    const app = createApp();
    await request(app).get("/healthz");
    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.text).toContain('service="identity"');
    expect(res.text).toContain("http_requests_total");
  });
});
