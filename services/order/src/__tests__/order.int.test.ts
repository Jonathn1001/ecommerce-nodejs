import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { prisma } from "../db";
import { ORDER_PLACED } from "@ecom/contracts";

const app = createApp();

async function seedPrice(productId: string, price: number) {
  await prisma.catalogReadModel.upsert({
    where: { productId },
    create: { productId, name: "x", price, version: 1 },
    update: { name: "x", price, version: 1 },
  });
}
async function addToCart(userId: string, productId: string, quantity: number) {
  await request(app)
    .post("/cart/items")
    .set("x-user-id", userId)
    .send({ productId, quantity });
}

describe("order checkout (integration — needs docker compose up + migrated)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("POST /orders prices the cart, writes a PENDING order + items + OrderPlaced outbox, clears the cart", async () => {
    const userId = `u_${randomUUID()}`;
    const p1 = `p_${randomUUID()}`;
    const p2 = `p_${randomUUID()}`;
    await seedPrice(p1, 100);
    await seedPrice(p2, 250);
    await addToCart(userId, p1, 2);
    await addToCart(userId, p2, 1);

    const res = await request(app).post("/orders").set("x-user-id", userId);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING");
    expect(res.body.totalPrice).toBe(450);
    const orderId = res.body.orderId as string;

    expect(await prisma.order.count({ where: { id: orderId, status: "PENDING" } })).toBe(
      1
    );
    expect(await prisma.orderItem.count({ where: { orderId } })).toBe(2);
    expect(
      await prisma.outbox.count({ where: { aggregateId: orderId, type: ORDER_PLACED } })
    ).toBe(1);

    const cart = await request(app).get("/cart").set("x-user-id", userId);
    expect(cart.body.items).toEqual([]);
  });

  it("422 UNPRICED leaves no order, no outbox, and the cart intact", async () => {
    const userId = `u_${randomUUID()}`;
    const pOK = `p_${randomUUID()}`;
    const pBad = `p_${randomUUID()}`; // never priced
    await seedPrice(pOK, 100);
    await addToCart(userId, pOK, 1);
    await addToCart(userId, pBad, 1);

    const res = await request(app).post("/orders").set("x-user-id", userId);
    expect(res.status).toBe(422);
    expect(res.body.productId).toBe(pBad);
    expect(await prisma.order.count({ where: { userId } })).toBe(0);
    const cart = await request(app).get("/cart").set("x-user-id", userId);
    expect(cart.body.items).toHaveLength(2);
  });

  it("400 when the cart is empty", async () => {
    const userId = `u_${randomUUID()}`;
    const res = await request(app).post("/orders").set("x-user-id", userId);
    expect(res.status).toBe(400);
  });

  it("GET /orders/:id returns the order; 404 when unknown", async () => {
    const userId = `u_${randomUUID()}`;
    const pid = `p_${randomUUID()}`;
    await seedPrice(pid, 300);
    await addToCart(userId, pid, 2);
    const placed = await request(app).post("/orders").set("x-user-id", userId);
    const got = await request(app).get(`/orders/${placed.body.orderId}`);
    expect(got.status).toBe(200);
    expect(got.body.totalPrice).toBe(600);
    expect(got.body.items).toHaveLength(1);

    const missing = await request(app).get(`/orders/order_${randomUUID()}`);
    expect(missing.status).toBe(404);
  });
});
