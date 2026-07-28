// MUST come first: it plants JWT_PRIVATE_KEY before ../app validates its config.
import "./test-key";
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app";

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
