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

  // NOTE: this case cannot fail under any implementation of loadForUpdate, locked or not.
  // updateProduct always does `version: { increment: 1 }` atomically at the SQL layer
  // (tx-adapters.ts:35, "version" = "version" + 1), so versions come out distinct regardless
  // of read staleness, and both 200 and 300 differ from the stale base 100, so priceChanged is
  // true for both requests independent of locking. It provides zero regression protection for
  // the lock this task implements — kept anyway because it still guards a real invariant (no
  // lost or duplicated version across concurrent updates). The same-price case below is the one
  // that actually proves the lock.
  it("two concurrent price PATCHes emit exactly two price_changed rows", async () => {
    const created = await request(app)
      .post("/products")
      .send({
        type: "ELECTRONICS",
        name: `p_${randomUUID()}`,
        price: 100,
        attributes: { manufacturer: "m", model: "x", color: "black" },
      })
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

  // The discriminating case: the 100->200/300 case above cannot prove the lock, because
  // Postgres's atomic `version = version + 1` UPDATE protects the version counter regardless
  // of whether the read is locked. `priceChanged` (product.ts:57) is decided purely from the
  // *stale read* of cur.price, so the real hazard shows up when both concurrent PATCHes target
  // the SAME new price: without a lock both transactions read cur.price=100 and both decide
  // priceChanged=true -> 2 events for one real transition. With `FOR UPDATE` the second
  // transaction blocks until the first commits, then reads cur.price=200 (already the target)
  // and correctly decides priceChanged=false -> exactly 1 event.
  // Detection is probabilistic pre-fix, not deterministic (observed ~3/6 runs failing): the bug
  // only manifests when both reads genuinely overlap before either commits. GREEN is
  // deterministic once the lock is in place, but a single green run after a future revert of the
  // lock is not conclusive on its own — this case needs repeated runs to reliably witness a
  // regression.
  it("two concurrent PATCHes to the SAME new price emit exactly one price_changed row", async () => {
    const created = await request(app)
      .post("/products")
      .send({
        type: "ELECTRONICS",
        name: `p_${randomUUID()}`,
        price: 100,
        attributes: { manufacturer: "m", model: "x", color: "black" },
      })
      .expect(201);
    const id = created.body.productId as string;

    await Promise.all([
      request(app).patch(`/products/${id}`).send({ price: 200 }),
      request(app).patch(`/products/${id}`).send({ price: 200 }),
    ]);

    const events = await prisma.outbox.findMany({
      where: { aggregateId: id, type: CATALOG_PRICE_CHANGED },
    });
    expect(events).toHaveLength(1);
  });
});
