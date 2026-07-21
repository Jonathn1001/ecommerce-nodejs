import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { sweepOnce } from "../sweeper";
import { prisma } from "../db";
import { getRedis } from "@ecom/shared";
import { INVENTORY_RELEASED } from "@ecom/contracts";

describe("expiry sweeper (integration — needs docker compose up + migrated)", () => {
  afterAll(async () => {
    (await getRedis()).quit();
    await prisma.$disconnect();
  });

  it("releases an expired ACTIVE reservation, restores stock, emits InventoryReleased", async () => {
    const productId = `p_${randomUUID()}`;
    const orderId = `o_${randomUUID()}`;
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
    const productId = `p_${randomUUID()}`;
    const orderId = `o_${randomUUID()}`;
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
});
