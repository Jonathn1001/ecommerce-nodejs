import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app";

describe("hello /metrics", () => {
  it("exposes prometheus metrics stamped with the service name", async () => {
    const app = createApp();
    await request(app).get("/healthz");
    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.text).toContain('service="hello"');
    expect(res.text).toContain("http_requests_total");
  });
});
