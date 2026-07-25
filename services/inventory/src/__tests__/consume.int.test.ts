import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { handleOrderEvent } from "../consumer";
import { prisma } from "../db";
import { makeEnvelope, ORDER_CONFIRMED, type EventEnvelope } from "@ecom/contracts";

async function activeReservation(orderId: string) {
  await prisma.reservation.create({
    data: {
      orderId,
      productId: `p_${randomUUID()}`,
      quantity: 1,
      status: "ACTIVE",
      expiresAt: new Date(Date.now() + 900_000),
    },
  });
}
const confirm = (orderId: string): EventEnvelope =>
  makeEnvelope({
    type: ORDER_CONFIRMED,
    version: 1,
    traceId: "t",
    producer: "test",
    payload: { orderId, userId: "u1" },
  });
const statusOf = async (orderId: string) =>
  (await prisma.reservation.findFirst({ where: { orderId } }))?.status;

describe("inventory CONSUMED (integration — needs compose up + migrated)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("OrderConfirmed marks the ACTIVE reservation CONSUMED", async () => {
    const orderId = `o_${randomUUID()}`;
    await activeReservation(orderId);
    await handleOrderEvent(confirm(orderId));
    expect(await statusOf(orderId)).toBe("CONSUMED");
  });

  it("dedupes a redelivered OrderConfirmed (stays CONSUMED, ledgered once)", async () => {
    const orderId = `o_${randomUUID()}`;
    await activeReservation(orderId);
    const e = confirm(orderId);
    await handleOrderEvent(e);
    await handleOrderEvent(e);
    expect(await statusOf(orderId)).toBe("CONSUMED");
    expect(await prisma.processedEvent.count({ where: { eventId: e.eventId } })).toBe(1);
  });

  it("no ACTIVE reservation (already released) -> no-op, no throw", async () => {
    const orderId = `o_${randomUUID()}`; // no reservation at all
    await handleOrderEvent(confirm(orderId));
    expect(await statusOf(orderId)).toBeUndefined();
  });
});
