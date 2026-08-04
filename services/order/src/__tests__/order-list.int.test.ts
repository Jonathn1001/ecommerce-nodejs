import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import { OrderListSchema } from "@ecom/contracts";
import { createApp } from "../app";
import { prisma } from "../db";

const app = createApp();

// Tag every order this file seeds so afterAll can find and delete them by a DB query rather
// than an in-memory id list — a mid-suite throw still gets cleaned up (7d convention).
const TEST_TAG = "test-order-list-int";
const tagged = () => `${TEST_TAG}-${randomUUID()}`;

async function seedOrder(userId: string, lines: number, createdAt: Date) {
  return prisma.order.create({
    data: {
      userId,
      status: "PENDING",
      totalPrice: 100 * lines,
      createdAt,
      items: {
        create: Array.from({ length: lines }, () => ({
          productId: `p_${randomUUID()}`,
          quantity: 1,
          unitPrice: 100,
        })),
      },
    },
  });
}

describe("order list (integration — needs compose up + migrated)", () => {
  afterAll(async () => {
    const seeded = await prisma.order.findMany({
      where: { userId: { startsWith: TEST_TAG } },
      select: { id: true },
    });
    const ids = seeded.map((o) => o.id);
    if (ids.length > 0) {
      // Outbox rows are keyed by aggregateId and do not cascade from Order (no FK), so they
      // are deleted separately or they keep tripping INV4_OUTBOX_UNSENT. OrderItem cascades.
      await prisma.outbox.deleteMany({ where: { aggregateId: { in: ids } } });
      await prisma.order.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.$disconnect();
  });

  it("returns only the caller's orders, newest first, with a line count", async () => {
    const mine = tagged();
    const theirs = tagged();
    const older = await seedOrder(mine, 1, new Date("2026-08-01T00:00:00.000Z"));
    const newer = await seedOrder(mine, 3, new Date("2026-08-02T00:00:00.000Z"));
    await seedOrder(theirs, 2, new Date("2026-08-03T00:00:00.000Z"));

    const res = await request(app).get("/orders").set("x-user-id", mine);

    expect(res.status).toBe(200);
    const parsed = OrderListSchema.parse(res.body);
    expect(parsed.map((o) => o.id)).toEqual([newer.id, older.id]);
    expect(parsed[0].itemCount).toBe(3);
    expect(parsed[1].itemCount).toBe(1);
  });

  it("caps the list at 50", async () => {
    const many = tagged();
    for (let i = 0; i < 51; i++) {
      await seedOrder(many, 1, new Date(2026, 0, 1, 0, 0, i));
    }
    const res = await request(app).get("/orders").set("x-user-id", many);
    expect(res.body).toHaveLength(50);
  });

  it("rejects a request with no caller", async () => {
    const res = await request(app).get("/orders");
    expect(res.status).toBe(400);
  });
});
