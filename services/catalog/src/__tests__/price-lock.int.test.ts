import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../db";
import { CATALOG_PRICE_CHANGED } from "@ecom/contracts";

const app = createApp();

describe("catalog price lock (integration — needs compose up + migrated)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("two concurrent price PATCHes emit exactly two price_changed rows", async () => {
    const created = await request(app)
      .post("/products")
      .send({ type: "ELECTRONICS", name: `p_${randomUUID()}`, price: 100, attributes: { manufacturer: "m", model: "x", color: "black" } })
      .expect(201);
    const id = created.body.productId as string;

    await Promise.all([
      request(app).patch(`/products/${id}`).send({ price: 200 }),
      request(app).patch(`/products/${id}`).send({ price: 300 }),
    ]);

    const events = await prisma.outbox.findMany({
      where: { aggregateId: id, type: CATALOG_PRICE_CHANGED },
      orderBy: { occurredAt: "asc" },
    });
    expect(events).toHaveLength(2);
    const versions = events.map((e) => (e.payload as { version: number }).version);
    expect(new Set(versions).size).toBe(2); // serialized: never the same version twice
  });
});
