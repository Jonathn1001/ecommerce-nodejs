import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { sweepOnce } from "../sweeper";
import { prisma } from "../db";
import { getRedis } from "@ecom/shared";
import { INVENTORY_RELEASED } from "@ecom/contracts";

// Tag every id this file invents so afterAll can find and delete the rows by a DB
// query, not an in-memory id list — a mid-suite throw still gets cleaned up. Two
// things leak here. The InventoryReleased outbox rows the sweep enqueues are never
// relayed during an integration test, so INV4_OUTBOX_UNSENT reports them. Worse, the
// poison case deliberately creates an expired ACTIVE reservation whose Inventory row
// does not exist, which is unsweepable by construction: left behind, the real sweeper
// retries it every cycle forever. That is the origin of the stale reservations the
// Phase 7c handover recorded as permanent sweeper noise.
const TEST_TAG = "test-sweeper-int";
const taggedProduct = () => `${TEST_TAG}-p-${randomUUID()}`;
const taggedOrder = () => `${TEST_TAG}-o-${randomUUID()}`;

describe("expiry sweeper (integration — needs docker compose up + migrated)", () => {
  afterAll(async () => {
    // No FKs anywhere in this schema, so the deletes are order-independent.
    await prisma.outbox.deleteMany({
      where: { aggregateId: { startsWith: `${TEST_TAG}-o` } },
    });
    await prisma.reservation.deleteMany({
      where: { orderId: { startsWith: `${TEST_TAG}-o` } },
    });
    await prisma.inventory.deleteMany({
      where: { productId: { startsWith: `${TEST_TAG}-p` } },
    });
    (await getRedis()).quit();
    await prisma.$disconnect();
  });

  it("releases an expired ACTIVE reservation, restores stock, emits InventoryReleased", async () => {
    const productId = taggedProduct();
    const orderId = taggedOrder();
    // available=3 models 2 already held out of an original 5
    await prisma.inventory.create({ data: { productId, available: 3 } });
    await prisma.reservation.create({
      data: {
        orderId,
        productId,
        quantity: 2,
        status: "ACTIVE",
        expiresAt: new Date(Date.now() - 60_000), // already expired
      },
    });

    const released = await sweepOnce();
    expect(released).toBeGreaterThanOrEqual(1);

    expect((await prisma.inventory.findUnique({ where: { productId } }))?.available).toBe(
      5
    );
    expect(
      await prisma.reservation.count({ where: { orderId, status: "RELEASED" } })
    ).toBe(1);
    expect(
      await prisma.outbox.count({
        where: { aggregateId: orderId, type: INVENTORY_RELEASED },
      })
    ).toBe(1);
  });

  it("leaves a not-yet-expired reservation alone", async () => {
    const productId = taggedProduct();
    const orderId = taggedOrder();
    await prisma.inventory.create({ data: { productId, available: 1 } });
    await prisma.reservation.create({
      data: {
        orderId,
        productId,
        quantity: 1,
        status: "ACTIVE",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    await sweepOnce();
    expect(await prisma.reservation.count({ where: { orderId, status: "ACTIVE" } })).toBe(
      1
    );
    expect((await prisma.inventory.findUnique({ where: { productId } }))?.available).toBe(
      1
    );
  });

  it("a poisoned order does not abandon the rest of the batch", async () => {
    // Reservation whose Inventory row is gone -> tx.inventory.update raises P2025.
    const deadProduct = taggedProduct();
    await prisma.reservation.create({
      data: {
        orderId: taggedOrder(),
        productId: deadProduct,
        quantity: 1,
        status: "ACTIVE",
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    // ...and a healthy expired reservation that must still be swept.
    const goodProduct = taggedProduct();
    await prisma.inventory.create({ data: { productId: goodProduct, available: 5 } });
    const goodOrder = taggedOrder();
    await prisma.reservation.create({
      data: {
        orderId: goodOrder,
        productId: goodProduct,
        quantity: 2,
        status: "ACTIVE",
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    await sweepOnce();

    expect(
      (await prisma.inventory.findUnique({ where: { productId: goodProduct } }))
        ?.available
    ).toBe(7);
    expect(
      (await prisma.reservation.findFirst({ where: { orderId: goodOrder } }))?.status
    ).toBe("RELEASED");
  });
});
