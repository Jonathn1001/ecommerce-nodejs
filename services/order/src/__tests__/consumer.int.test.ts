import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { handleEvent } from "../consumer";
import { prisma } from "../db";
import {
  makeEnvelope, INVENTORY_RESERVED, PAYMENT_SUCCEEDED, PAYMENT_FAILED,
  CHARGE_PAYMENT, ORDER_CONFIRMED, ORDER_CANCELLED, type EventEnvelope,
} from "@ecom/contracts";

async function seedOrder(status: string, totalPrice = 500): Promise<string> {
  const o = await prisma.order.create({
    data: { userId: `u_${randomUUID()}`, status, totalPrice,
      items: { create: [{ productId: `p_${randomUUID()}`, quantity: 1, unitPrice: totalPrice }] } },
  });
  return o.id;
}
const env = (type: string, orderId: string, payload: object = { orderId }): EventEnvelope =>
  makeEnvelope({ type, version: 1, traceId: "t", producer: "test", payload });
const statusOf = async (id: string) => (await prisma.order.findUnique({ where: { id } }))?.status;
const outbox = (id: string, type: string) => prisma.outbox.count({ where: { aggregateId: id, type } });

describe("order payment-leg consumer (integration — needs compose up + migrated)", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("InventoryReserved -> AWAITING_PAYMENT + one ChargePayment outbox (amount=totalPrice)", async () => {
    const id = await seedOrder("PENDING", 700);
    await handleEvent(env(INVENTORY_RESERVED, id, { orderId: id, items: [{ productId: "p1", quantity: 1 }] }));
    expect(await statusOf(id)).toBe("AWAITING_PAYMENT");
    expect(await outbox(id, CHARGE_PAYMENT)).toBe(1);
    const row = await prisma.outbox.findFirst({ where: { aggregateId: id, type: CHARGE_PAYMENT } });
    expect((row!.payload as { amount: number }).amount).toBe(700);
  });

  it("PaymentSucceeded -> CONFIRMED + one OrderConfirmed outbox", async () => {
    const id = await seedOrder("AWAITING_PAYMENT");
    await handleEvent(env(PAYMENT_SUCCEEDED, id, { orderId: id, paymentId: "pay_1", amount: 500 }));
    expect(await statusOf(id)).toBe("CONFIRMED");
    expect(await outbox(id, ORDER_CONFIRMED)).toBe(1);
  });

  it("PaymentFailed -> CANCELLED + one OrderCancelled outbox", async () => {
    const id = await seedOrder("AWAITING_PAYMENT");
    await handleEvent(env(PAYMENT_FAILED, id, { orderId: id, reason: "CARD_DECLINED" }));
    expect(await statusOf(id)).toBe("CANCELLED");
    expect(await outbox(id, ORDER_CANCELLED)).toBe(1);
  });

  it("dedupes a redelivered PaymentSucceeded", async () => {
    const id = await seedOrder("AWAITING_PAYMENT");
    const e = env(PAYMENT_SUCCEEDED, id, { orderId: id, paymentId: "p", amount: 500 });
    await handleEvent(e); await handleEvent(e);
    expect(await statusOf(id)).toBe("CONFIRMED");
    expect(await outbox(id, ORDER_CONFIRMED)).toBe(1);
  });

  it("unknown order is acked without a ProcessedEvent row", async () => {
    const e = env(PAYMENT_SUCCEEDED, `o_${randomUUID()}`, { orderId: "x", paymentId: "p", amount: 1 });
    await handleEvent(e);
    expect(await prisma.processedEvent.count({ where: { eventId: e.eventId } })).toBe(0);
  });
});
