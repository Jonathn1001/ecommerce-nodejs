import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createHealthRouter } from "../health";

describe("createHealthRouter", () => {
  it("healthz is always ok", async () => {
    const app = express().use(createHealthRouter());
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("readyz is 503 and lists the failing check", async () => {
    const app = express().use(
      createHealthRouter({
        db: async () => {},
        broker: async () => {
          throw new Error("down");
        },
      })
    );
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.failed).toContain("broker");
  });
});
