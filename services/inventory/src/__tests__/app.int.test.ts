import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { prisma } from "../db";
import { getRedis } from "@ecom/shared";

const app = createApp();

describe("inventory HTTP admin (integration — needs docker compose up + migrated)", () => {
  afterAll(async () => {
    (await getRedis()).quit();
    await prisma.$disconnect();
  });

  it("POST /inventory/stock seeds then increments the same product", async () => {
    const productId = `p_${randomUUID()}`;
    const seed = await request(app)
      .post("/inventory/stock")
      .send({ productId, quantity: 5 });
    expect(seed.status).toBe(201);
    expect(seed.body).toEqual({ productId, available: 5 });

    const add = await request(app)
      .post("/inventory/stock")
      .send({ productId, quantity: 3 });
    expect(add.body.available).toBe(8);
  });

  it("POST /inventory/stock rejects a non-positive quantity", async () => {
    const res = await request(app)
      .post("/inventory/stock")
      .send({ productId: "x", quantity: 0 });
    expect(res.status).toBe(400);
  });

  it("GET /inventory/:productId returns level + active reservation count, 404 when unknown", async () => {
    const productId = `p_${randomUUID()}`;
    await request(app).post("/inventory/stock").send({ productId, quantity: 4 });
    const res = await request(app).get(`/inventory/${productId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ productId, available: 4, activeReservations: 0 });

    const missing = await request(app).get(`/inventory/p_${randomUUID()}`);
    expect(missing.status).toBe(404);
  });

  it("GET /readyz reports healthy", async () => {
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(200);
  });
});
