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

// Tag every orderId this file invents so afterAll can find and delete the rows by a DB
// query, not an in-memory id list — a mid-suite throw still gets cleaned up. Dispatching
// enqueues a SendEmail outbox row keyed by orderId, and no relay runs during an integration
// test, so it sits unsent and INV4_OUTBOX_UNSENT reports it. The Notification rows go with
// them: they are PENDING and would be picked up as real work by a live mailer.
const TEST_TAG = "test-dispatcher-int";
const taggedOrder = () => `${TEST_TAG}-o-${randomUUID()}`;

describe("notification dispatcher (integration — needs compose up + migrated)", () => {
  afterAll(async () => {
    // Notification has no FK to Outbox or vice versa, so the deletes are independent.
    await prisma.outbox.deleteMany({ where: { aggregateId: { startsWith: TEST_TAG } } });
    await prisma.notification.deleteMany({
      where: { orderId: { startsWith: TEST_TAG } },
    });
    await prisma.$disconnect();
  });

  it("creates one Notification(PENDING) + one SendEmail outbox; dedupes redelivery", async () => {
    const orderId = taggedOrder();
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
    const orderId = taggedOrder();
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
