import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { handleOrderEvent } from "../consumer";
import { prisma } from "../db";
import { makeEnvelope, ORDER_CONFIRMED, type EventEnvelope } from "@ecom/contracts";
import { SEND_EMAIL } from "../commands";

const ev = (orderId: string, userId: string): EventEnvelope =>
  makeEnvelope({
    type: ORDER_CONFIRMED,
    version: 1,
    traceId: "t",
    producer: "order",
    payload: { orderId, userId },
  });

describe("notification dispatcher (integration — needs compose up + migrated)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates one Notification(PENDING) + one SendEmail outbox; dedupes redelivery", async () => {
    const orderId = `o_${randomUUID()}`;
    const e = ev(orderId, "u1");
    await handleOrderEvent(e);
    await handleOrderEvent(e); // redelivery
    const n = await prisma.notification.findFirst({
      where: { orderId, type: ORDER_CONFIRMED },
    });
    expect(n?.status).toBe("PENDING");
    expect(n?.to).toBe("u1@example.test");
    expect(
      await prisma.outbox.count({ where: { aggregateId: orderId, type: SEND_EMAIL } })
    ).toBe(1);
    expect(await prisma.processedEvent.count({ where: { eventId: e.eventId } })).toBe(1);
  });

  it("a second event with a fresh eventId but the same (orderId,type) enqueues nothing", async () => {
    const orderId = `o_${randomUUID()}`;
    await handleOrderEvent(ev(orderId, "u1"));
    await handleOrderEvent(ev(orderId, "u1")); // different eventId, same pair
    expect(
      await prisma.notification.count({ where: { orderId, type: ORDER_CONFIRMED } })
    ).toBe(1);
    expect(
      await prisma.outbox.count({ where: { aggregateId: orderId, type: SEND_EMAIL } })
    ).toBe(1);
  });
});
