import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { handleOrderEvent } from "../consumer";
import { prisma } from "../db";
import { getRedis } from "@ecom/shared";
import {
  makeEnvelope,
  ORDER_PLACED,
  ORDER_CANCELLED,
  INVENTORY_RESERVED,
  INVENTORY_RESERVATION_FAILED,
  INVENTORY_RELEASED,
} from "@ecom/contracts";

async function seed(productId: string, available: number) {
  await prisma.inventory.upsert({
    where: { productId },
    create: { productId, available },
    update: { available },
  });
}
async function availableOf(productId: string) {
  return (await prisma.inventory.findUnique({ where: { productId } }))?.available;
}
function placed(orderId: string, items: Array<{ productId: string; quantity: number }>) {
  return makeEnvelope({ type: ORDER_PLACED, version: 1, traceId: "t", producer: "test", payload: { orderId, items } });
}

describe("inventory consumer (integration — needs docker compose up + migrated)", () => {
  afterAll(async () => {
    (await getRedis()).quit();
    await prisma.$disconnect();
  });

  it("OrderPlaced reserves: decrements stock, writes an ACTIVE reservation + InventoryReserved outbox", async () => {
    const p1 = `p_${randomUUID()}`;
    const orderId = `o_${randomUUID()}`;
    await seed(p1, 5);
    await handleOrderEvent(placed(orderId, [{ productId: p1, quantity: 3 }]));

    expect(await availableOf(p1)).toBe(2);
    expect(await prisma.reservation.count({ where: { orderId, status: "ACTIVE" } })).toBe(1);
    expect(await prisma.outbox.count({ where: { aggregateId: orderId, type: INVENTORY_RESERVED } })).toBe(1);
  });

  it("insufficient stock emits InventoryReservationFailed and leaves stock untouched", async () => {
    const p1 = `p_${randomUUID()}`;
    const orderId = `o_${randomUUID()}`;
    await seed(p1, 1);
    await handleOrderEvent(placed(orderId, [{ productId: p1, quantity: 3 }]));

    expect(await availableOf(p1)).toBe(1);
    expect(await prisma.reservation.count({ where: { orderId } })).toBe(0);
    expect(await prisma.outbox.count({ where: { aggregateId: orderId, type: INVENTORY_RESERVATION_FAILED } })).toBe(1);
  });

  it("is all-or-nothing across items", async () => {
    const p1 = `p_${randomUUID()}`;
    const p2 = `p_${randomUUID()}`;
    const orderId = `o_${randomUUID()}`;
    await seed(p1, 5);
    await seed(p2, 0);
    await handleOrderEvent(placed(orderId, [{ productId: p1, quantity: 2 }, { productId: p2, quantity: 1 }]));

    expect(await availableOf(p1)).toBe(5); // p1 decrement rolled back
    expect(await prisma.outbox.count({ where: { aggregateId: orderId, type: INVENTORY_RESERVATION_FAILED } })).toBe(1);
  });

  it("OrderCancelled releases the reservation and restores stock", async () => {
    const p1 = `p_${randomUUID()}`;
    const orderId = `o_${randomUUID()}`;
    await seed(p1, 5);
    await handleOrderEvent(placed(orderId, [{ productId: p1, quantity: 2 }]));
    expect(await availableOf(p1)).toBe(3);

    await handleOrderEvent(
      makeEnvelope({ type: ORDER_CANCELLED, version: 1, traceId: "t", producer: "test", payload: { orderId } })
    );
    expect(await availableOf(p1)).toBe(5);
    expect(await prisma.reservation.count({ where: { orderId, status: "RELEASED" } })).toBe(1);
    expect(await prisma.outbox.count({ where: { aggregateId: orderId, type: INVENTORY_RELEASED } })).toBe(1);
  });

  it("dedupes a redelivered OrderPlaced (reserves once)", async () => {
    const p1 = `p_${randomUUID()}`;
    const orderId = `o_${randomUUID()}`;
    await seed(p1, 5);
    const env = placed(orderId, [{ productId: p1, quantity: 2 }]);
    await handleOrderEvent(env);
    await handleOrderEvent(env); // same eventId

    expect(await availableOf(p1)).toBe(3); // decremented once
    expect(await prisma.reservation.count({ where: { orderId } })).toBe(1);
  });
});
