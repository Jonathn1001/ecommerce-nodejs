import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app";

// `.int` rather than a plain unit test, unlike the same test in six other services:
// payment's app.ts imports ./config at module scope, so merely importing createApp
// runs the config schema and needs DATABASE_URL + PAYMENT_WEBHOOK_SECRET. The quality
// CI lane runs with no database and no .env files, so this belongs in the integration
// lane, which exports both. (identity/src/__tests__/metrics.int.test.ts is the same case.)
describe("payment /metrics", () => {
  it("exposes prometheus metrics stamped with the service name", async () => {
    const app = createApp({ rabbitHealth: async () => {} });
    await request(app).get("/healthz");
    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.text).toContain('service="payment"');
  });
});
