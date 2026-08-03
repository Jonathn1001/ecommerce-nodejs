import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { handleEvent } from "../consumer";
import { prisma } from "../db";
import {
  makeEnvelope,
  INVENTORY_RESERVED,
  PAYMENT_SUCCEEDED,
  PAYMENT_FAILED,
  CHARGE_PAYMENT,
  ORDER_CONFIRMED,
  ORDER_CANCELLED,
  type EventEnvelope,
} from "@ecom/contracts";

// Tag every order this file seeds so afterAll can find and delete them by a DB
// query, not an in-memory id list — a mid-suite throw still gets cleaned up.
// These tests drive handleEvent with a fake PaymentSucceeded straight into the
// order database, so several land in CONFIRMED with no Payment row behind them
// at all — a state the real system cannot produce (payment always goes through
// the payment service first). Left uncleaned, that trips INV6_CONFIRMED_INCOMPLETE
// on every run.
const TEST_TAG = "test-consumer-int";

async function seedOrder(status: string, totalPrice = 500): Promise<string> {
  const o = await prisma.order.create({
    data: {
      userId: `${TEST_TAG}-${randomUUID()}`,
      status,
      totalPrice,
      items: {
        create: [{ productId: `p_${randomUUID()}`, quantity: 1, unitPrice: totalPrice }],
      },
    },
  });
  return o.id;
}
const env = (
  type: string,
  orderId: string,
  payload: object = { orderId }
): EventEnvelope =>
  makeEnvelope({ type, version: 1, traceId: "t", producer: "test", payload });
const statusOf = async (id: string) =>
  (await prisma.order.findUnique({ where: { id } }))?.status;
const outbox = (id: string, type: string) =>
  prisma.outbox.count({ where: { aggregateId: id, type } });
const outboxPayload = async (id: string, type: string) =>
  (await prisma.outbox.findFirst({ where: { aggregateId: id, type } }))?.payload as
    Record<string, unknown> | undefined;
const userIdOf = async (id: string) =>
  (await prisma.order.findUnique({ where: { id } }))?.userId;

describe("order payment-leg consumer (integration — needs compose up + migrated)", () => {
  afterAll(async () => {
    // Outbox rows are keyed by aggregateId, not userId, and do not cascade from
    // Order (no FK) — deleted separately or they keep tripping INV4_OUTBOX_UNSENT.
    // OrderItem does cascade (onDelete: Cascade in schema.prisma).
    const seeded = await prisma.order.findMany({
      where: { userId: { startsWith: TEST_TAG } },
      select: { id: true },
    });
    const ids = seeded.map((o) => o.id);
    if (ids.length > 0) {
      await prisma.outbox.deleteMany({ where: { aggregateId: { in: ids } } });
      await prisma.order.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.$disconnect();
  });

  it("InventoryReserved -> AWAITING_PAYMENT + one ChargePayment outbox (amount=totalPrice)", async () => {
    const id = await seedOrder("PENDING", 700);
    await handleEvent(
      env(INVENTORY_RESERVED, id, {
        orderId: id,
        items: [{ productId: "p1", quantity: 1 }],
      })
    );
    expect(await statusOf(id)).toBe("AWAITING_PAYMENT");
    expect(await outbox(id, CHARGE_PAYMENT)).toBe(1);
    const row = await prisma.outbox.findFirst({
      where: { aggregateId: id, type: CHARGE_PAYMENT },
    });
    expect((row!.payload as { amount: number }).amount).toBe(700);
  });

  it("PaymentSucceeded -> CONFIRMED + one OrderConfirmed outbox", async () => {
    const id = await seedOrder("AWAITING_PAYMENT");
    await handleEvent(
      env(PAYMENT_SUCCEEDED, id, { orderId: id, paymentId: "pay_1", amount: 500 })
    );
    expect(await statusOf(id)).toBe("CONFIRMED");
    expect(await outbox(id, ORDER_CONFIRMED)).toBe(1);
    // Notification addresses the customer off this field — it must ride the event.
    expect(await outboxPayload(id, ORDER_CONFIRMED)).toEqual({
      orderId: id,
      userId: await userIdOf(id),
    });
  });

  it("PaymentFailed -> CANCELLED + one OrderCancelled outbox", async () => {
    const id = await seedOrder("AWAITING_PAYMENT");
    await handleEvent(env(PAYMENT_FAILED, id, { orderId: id, reason: "CARD_DECLINED" }));
    expect(await statusOf(id)).toBe("CANCELLED");
    expect(await outbox(id, ORDER_CANCELLED)).toBe(1);
    expect(await outboxPayload(id, ORDER_CANCELLED)).toEqual({
      orderId: id,
      userId: await userIdOf(id),
    });
  });

  it("dedupes a redelivered PaymentSucceeded", async () => {
    const id = await seedOrder("AWAITING_PAYMENT");
    const e = env(PAYMENT_SUCCEEDED, id, { orderId: id, paymentId: "p", amount: 500 });
    await handleEvent(e);
    await handleEvent(e);
    expect(await statusOf(id)).toBe("CONFIRMED");
    expect(await outbox(id, ORDER_CONFIRMED)).toBe(1);
  });

  it("unknown order is acked without a ProcessedEvent row", async () => {
    const e = env(PAYMENT_SUCCEEDED, `o_${randomUUID()}`, {
      orderId: "x",
      paymentId: "p",
      amount: 1,
    });
    await handleEvent(e);
    expect(await prisma.processedEvent.count({ where: { eventId: e.eventId } })).toBe(0);
  });
});
