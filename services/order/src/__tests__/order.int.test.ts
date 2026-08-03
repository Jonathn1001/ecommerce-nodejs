import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { prisma } from "../db";
import { ORDER_PLACED } from "@ecom/contracts";

const app = createApp();

// Tag every caller this file checks out as, so afterAll can find and delete their
// orders by a DB query, not an in-memory id list — a mid-suite throw still gets
// cleaned up. These orders are placed through the real route, so they are
// legitimate PENDING rows with a real unsent OrderPlaced outbox entry; nothing
// advances or relays them during an integration test, so they sit there tripping
// INV1_ORDER_TERMINAL and INV4_OUTBOX_UNSENT at two per run.
const TEST_TAG = "test-order-int";
const tagged = () => `${TEST_TAG}-${randomUUID()}`;

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
    // Outbox rows are keyed by aggregateId, not userId, and do not cascade from
    // Order (no FK) — deleted separately or they keep tripping INV4_OUTBOX_UNSENT.
    // OrderItem does cascade (onDelete: Cascade in schema.prisma).
    const seeded = await prisma.order.findMany({
      where: { userId: { startsWith: TEST_TAG } },
      select: { id: true },
    });
    const ids = seeded.map((o) => o.id);
    if (ids.length > 0) {
      await prisma.outbox.deleteMany({ where: { aggregateId: { in: ids } } });
      await prisma.order.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.$disconnect();
  });

  it("POST /orders prices the cart, writes a PENDING order + items + OrderPlaced outbox, clears the cart", async () => {
    const userId = tagged();
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
    const userId = tagged();
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
    const userId = tagged();
    const res = await request(app).post("/orders").set("x-user-id", userId);
    expect(res.status).toBe(400);
  });

  it("GET /orders/:id returns the order; 404 when unknown", async () => {
    const userId = tagged();
    const pid = `p_${randomUUID()}`;
    await seedPrice(pid, 300);
    await addToCart(userId, pid, 2);
    const placed = await request(app).post("/orders").set("x-user-id", userId);
    const got = await request(app)
      .get(`/orders/${placed.body.orderId}`)
      .set("x-user-id", userId);
    expect(got.status).toBe(200);
    expect(got.body.totalPrice).toBe(600);
    expect(got.body.items).toHaveLength(1);

    const missing = await request(app)
      .get(`/orders/order_${randomUUID()}`)
      .set("x-user-id", userId);
    expect(missing.status).toBe(404);
  });
});
