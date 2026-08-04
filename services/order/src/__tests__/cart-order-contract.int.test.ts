import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { prisma } from "../db";
import { CartSchema, PlacedOrderSchema, OrderDetailSchema } from "@ecom/contracts";

const app = createApp();

// Order asserting its OWN responses against the shared schemas is what makes the storefront
// safe. A client that only validates on its side discovers drift at runtime, in a browser, as
// a blank cart. Here, drift fails a backend test next to the change that caused it.
describe("order cart/order API satisfies the shared contracts", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("GET /cart satisfies CartSchema", async () => {
    const userId = `u_${randomUUID()}`;
    const productId = `p_${randomUUID()}`;
    await request(app)
      .post("/cart/items")
      .set("x-user-id", userId)
      .send({ productId, quantity: 2 })
      .expect(201);

    const res = await request(app).get("/cart").set("x-user-id", userId).expect(200);
    const parsed = CartSchema.safeParse(res.body);
    if (!parsed.success) throw new Error(`cart drifted: ${parsed.error.message}`);
    expect(parsed.data.items).toEqual([{ productId, quantity: 2 }]);
  });

  it("POST /orders satisfies PlacedOrderSchema and GET /orders/:id satisfies OrderDetailSchema", async () => {
    const userId = `u_${randomUUID()}`;
    const productId = `p_${randomUUID()}`;
    // The order service prices from its catalog read-model; without a row the placement is
    // UNPRICED (422), so seed one directly, exactly as the existing suites do.
    await prisma.catalogReadModel.upsert({
      where: { productId },
      create: { productId, name: "contract widget", price: 900, version: 1 },
      update: { name: "contract widget", price: 900, version: 1 },
    });
    await request(app)
      .post("/cart/items")
      .set("x-user-id", userId)
      .send({ productId, quantity: 2 })
      .expect(201);

    const placed = await request(app)
      .post("/orders")
      .set("x-user-id", userId)
      .expect(201);
    const p = PlacedOrderSchema.safeParse(placed.body);
    if (!p.success) throw new Error(`placed order drifted: ${p.error.message}`);
    expect(p.data.totalPrice).toBe(1800);

    const got = await request(app)
      .get(`/orders/${p.data.orderId}`)
      .set("x-user-id", userId)
      .expect(200);
    const d = OrderDetailSchema.safeParse(got.body);
    if (!d.success) throw new Error(`order detail drifted: ${d.error.message}`);
    expect(d.data.id).toBe(p.data.orderId);
  });

  // The two shapes are genuinely different — POST answers with `orderId` and no `userId` or
  // `createdAt`, GET with `id` plus both. One schema would have to make the identifier
  // optional, and a missing id would then parse clean.
  it("the placed and detail schemas reject each other's bodies", async () => {
    const userId = `u_${randomUUID()}`;
    const productId = `p_${randomUUID()}`;
    await prisma.catalogReadModel.upsert({
      where: { productId },
      create: { productId, name: "contract widget", price: 500, version: 1 },
      update: { name: "contract widget", price: 500, version: 1 },
    });
    await request(app)
      .post("/cart/items")
      .set("x-user-id", userId)
      .send({ productId, quantity: 1 })
      .expect(201);
    const placed = await request(app)
      .post("/orders")
      .set("x-user-id", userId)
      .expect(201);
    const got = await request(app)
      .get(`/orders/${placed.body.orderId}`)
      .set("x-user-id", userId)
      .expect(200);

    expect(OrderDetailSchema.safeParse(placed.body).success).toBe(false);
    expect(PlacedOrderSchema.safeParse(got.body).success).toBe(false);
  });
});
