import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { prisma } from "../db";

const app = createApp();

describe("order cart + catalog admin (integration — needs docker compose up + migrated)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("POST /cart/items adds then increments the same product", async () => {
    const userId = `u_${randomUUID()}`;
    const pid = `p_${randomUUID()}`;
    const a = await request(app)
      .post("/cart/items")
      .set("x-user-id", userId)
      .send({ productId: pid, quantity: 2 });
    expect(a.status).toBe(201);
    const b = await request(app)
      .post("/cart/items")
      .set("x-user-id", userId)
      .send({ productId: pid, quantity: 3 });
    expect(b.status).toBe(201);
    const get = await request(app).get("/cart").set("x-user-id", userId);
    expect(get.body).toEqual({ userId, items: [{ productId: pid, quantity: 5 }] });
  });

  it("PATCH sets quantity; 0 removes the line", async () => {
    const userId = `u_${randomUUID()}`;
    const pid = `p_${randomUUID()}`;
    await request(app)
      .post("/cart/items")
      .set("x-user-id", userId)
      .send({ productId: pid, quantity: 4 });
    const patch = await request(app)
      .patch(`/cart/items/${pid}`)
      .set("x-user-id", userId)
      .send({ quantity: 1 });
    expect(patch.status).toBe(200);
    let get = await request(app).get("/cart").set("x-user-id", userId);
    expect(get.body.items).toEqual([{ productId: pid, quantity: 1 }]);
    const zero = await request(app)
      .patch(`/cart/items/${pid}`)
      .set("x-user-id", userId)
      .send({ quantity: 0 });
    expect(zero.status).toBe(200);
    get = await request(app).get("/cart").set("x-user-id", userId);
    expect(get.body.items).toEqual([]);
  });

  it("DELETE removes a line", async () => {
    const userId = `u_${randomUUID()}`;
    const pid = `p_${randomUUID()}`;
    await request(app)
      .post("/cart/items")
      .set("x-user-id", userId)
      .send({ productId: pid, quantity: 2 });
    const del = await request(app).delete(`/cart/items/${pid}`).set("x-user-id", userId);
    expect(del.status).toBe(200);
    const get = await request(app).get("/cart").set("x-user-id", userId);
    expect(get.body.items).toEqual([]);
  });

  it("400 when the x-user-id header is missing", async () => {
    const res = await request(app).get("/cart");
    expect(res.status).toBe(400);
  });

  it("POST /cart/items rejects a non-positive quantity", async () => {
    const res = await request(app)
      .post("/cart/items")
      .set("x-user-id", "u")
      .send({ productId: "p", quantity: 0 });
    expect(res.status).toBe(400);
  });

  it("POST /admin/catalog upserts a price", async () => {
    const pid = `p_${randomUUID()}`;
    const a = await request(app)
      .post("/admin/catalog")
      .send({ productId: pid, name: "Widget", price: 500 });
    expect(a.status).toBe(201);
    expect(a.body).toEqual({ productId: pid, price: 500 });
    const b = await request(app)
      .post("/admin/catalog")
      .send({ productId: pid, name: "Widget", price: 650 });
    expect(b.body.price).toBe(650);
  });

  it("GET /readyz reports healthy", async () => {
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(200);
  });
});
