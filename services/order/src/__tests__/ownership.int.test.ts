import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../db";
import { SubscriberRegistry } from "../sse-listener";

// A registry is required or the stream route answers 503 before it ever checks ownership.
const app = createApp({ sseRegistry: new SubscriberRegistry() });

// Tag every order this file seeds so afterAll can find and delete them by a DB
// query, not an in-memory id list — a mid-suite throw still gets cleaned up.
// Every order here is left in PENDING, which is exactly what INV1_ORDER_TERMINAL
// reports: no consumer runs during an integration test, so nothing ever advances
// them. Left uncleaned they accumulate at four per run.
const TEST_TAG = "test-ownership-int";
const tagged = () => `${TEST_TAG}-${randomUUID()}`;

async function seedOrder(userId: string): Promise<string> {
  const o = await prisma.order.create({
    data: {
      userId,
      status: "PENDING",
      totalPrice: 100,
      items: {
        create: [{ productId: `p_${randomUUID()}`, quantity: 1, unitPrice: 100 }],
      },
    },
  });
  return o.id;
}

// Before Phase 6 these routes looked an order up by id alone. That was invisible without
// identity; with the gateway injecting a verified caller it would be an IDOR — any logged-in
// user could read, and live-stream, anyone's order.
describe("order ownership (integration — needs compose up + migrated)", () => {
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

  it("the owner can read their order", async () => {
    const owner = tagged();
    const id = await seedOrder(owner);
    const res = await request(app)
      .get(`/orders/${id}`)
      .set("x-user-id", owner)
      .expect(200);
    expect(res.body.id).toBe(id);
  });

  it("another user gets 404 — not 403, so ids stay unenumerable", async () => {
    const id = await seedOrder(tagged());
    await request(app)
      .get(`/orders/${id}`)
      .set("x-user-id", `u_${randomUUID()}`)
      .expect(404);
  });

  it("a caller with no identity cannot read an order", async () => {
    const id = await seedOrder(tagged());
    await request(app).get(`/orders/${id}`).expect(400);
  });

  it("another user cannot open the stream", async () => {
    const id = await seedOrder(tagged());
    await request(app)
      .get(`/orders/${id}/stream`)
      .set("x-user-id", `u_${randomUUID()}`)
      .expect(404);
  });
});
