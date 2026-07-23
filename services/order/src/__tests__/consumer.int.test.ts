import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { handleInventoryEvent } from "../consumer";
import { prisma } from "../db";
import {
  makeEnvelope,
  INVENTORY_RESERVED,
  INVENTORY_RESERVATION_FAILED,
  ORDER_CANCELLED,
  type EventEnvelope,
} from "@ecom/contracts";

async function seedOrder(status = "PENDING"): Promise<string> {
  const order = await prisma.order.create({
    data: {
      userId: `u_${randomUUID()}`,
      status,
      totalPrice: 100,
      items: {
        create: [{ productId: `p_${randomUUID()}`, quantity: 1, unitPrice: 100 }],
      },
    },
  });
  return order.id;
}
function reserved(orderId: string): EventEnvelope {
  return makeEnvelope({
    type: INVENTORY_RESERVED,
    version: 1,
    traceId: "t",
    producer: "test",
    payload: { orderId, items: [{ productId: "p1", quantity: 1 }] },
  });
}
function failed(orderId: string): EventEnvelope {
  return makeEnvelope({
    type: INVENTORY_RESERVATION_FAILED,
    version: 1,
    traceId: "t",
    producer: "test",
    payload: { orderId, reason: "INSUFFICIENT_STOCK" },
  });
}
async function statusOf(orderId: string) {
  return (await prisma.order.findUnique({ where: { id: orderId } }))?.status;
}
const cancelledOutbox = (orderId: string) =>
  prisma.outbox.count({ where: { aggregateId: orderId, type: ORDER_CANCELLED } });
const ledgerCount = (eventId: string) =>
  prisma.processedEvent.count({ where: { eventId } });

describe("order inventory-result consumer (integration — needs docker compose up + migrated)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("InventoryReserved: PENDING -> AWAITING_PAYMENT, ledgered, no OrderCancelled", async () => {
    const orderId = await seedOrder();
    const env = reserved(orderId);
    await handleInventoryEvent(env);
    expect(await statusOf(orderId)).toBe("AWAITING_PAYMENT");
    expect(await ledgerCount(env.eventId)).toBe(1);
    expect(await cancelledOutbox(orderId)).toBe(0);
  });

  it("InventoryReservationFailed: PENDING -> CANCELLED, ledgered, one OrderCancelled outbox", async () => {
    const orderId = await seedOrder();
    const env = failed(orderId);
    await handleInventoryEvent(env);
    expect(await statusOf(orderId)).toBe("CANCELLED");
    expect(await ledgerCount(env.eventId)).toBe(1);
    expect(await cancelledOutbox(orderId)).toBe(1);
  });

  it("dedupes a redelivered event: second delivery is a no-op", async () => {
    const orderId = await seedOrder();
    const env = reserved(orderId);
    await handleInventoryEvent(env);
    await handleInventoryEvent(env); // same eventId
    expect(await statusOf(orderId)).toBe("AWAITING_PAYMENT");
    expect(await ledgerCount(env.eventId)).toBe(1);
  });

  it("unknown orderId: acked with no ProcessedEvent row (replay-recoverable)", async () => {
    const env = reserved(`o_${randomUUID()}`); // order never created
    await handleInventoryEvent(env);
    expect(await ledgerCount(env.eventId)).toBe(0);
  });

  it("out-of-order guard: Reserved after CANCELLED stays CANCELLED", async () => {
    const orderId = await seedOrder("CANCELLED");
    await handleInventoryEvent(reserved(orderId));
    expect(await statusOf(orderId)).toBe("CANCELLED");
  });
});
