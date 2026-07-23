import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { handleChargePayment } from "../consumer";
import { prisma } from "../db";
import {
  makeEnvelope,
  CHARGE_PAYMENT,
  PAYMENT_SUCCEEDED,
  PAYMENT_FAILED,
  type EventEnvelope,
} from "@ecom/contracts";

function chargeCmd(orderId: string, amount: number): EventEnvelope {
  return makeEnvelope({
    type: CHARGE_PAYMENT,
    version: 1,
    traceId: "t",
    producer: "test",
    payload: { orderId, amount },
  });
}
const outboxCount = (orderId: string, type: string) =>
  prisma.outbox.count({ where: { aggregateId: orderId, type } });
const statusOf = async (orderId: string) =>
  (await prisma.payment.findUnique({ where: { orderId } }))?.status;

describe("payment charge consumer (integration — needs docker compose up + migrated)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("charges a success amount -> Payment SUCCEEDED + one PaymentSucceeded outbox + one attempt", async () => {
    const orderId = `o_${randomUUID()}`;
    await handleChargePayment(chargeCmd(orderId, 500));
    expect(await statusOf(orderId)).toBe("SUCCEEDED");
    expect(await outboxCount(orderId, PAYMENT_SUCCEEDED)).toBe(1);
    const pay = await prisma.payment.findUnique({ where: { orderId } });
    expect(await prisma.paymentAttempt.count({ where: { paymentId: pay!.id } })).toBe(1);
  });

  it("declines a ...01 amount -> Payment FAILED + one PaymentFailed outbox", async () => {
    const orderId = `o_${randomUUID()}`;
    await handleChargePayment(chargeCmd(orderId, 101));
    expect(await statusOf(orderId)).toBe("FAILED");
    expect(await outboxCount(orderId, PAYMENT_FAILED)).toBe(1);
  });

  it("dedupes a redelivered command -> one payment, one ProcessedEvent", async () => {
    const orderId = `o_${randomUUID()}`;
    const cmd = chargeCmd(orderId, 500);
    await handleChargePayment(cmd);
    await handleChargePayment(cmd); // same eventId
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1);
    expect(await prisma.processedEvent.count({ where: { eventId: cmd.eventId } })).toBe(
      1
    );
  });

  it("re-sent command (new eventId, same order) -> still one payment (ALREADY_CHARGED)", async () => {
    const orderId = `o_${randomUUID()}`;
    await handleChargePayment(chargeCmd(orderId, 500));
    await handleChargePayment(chargeCmd(orderId, 500)); // different eventId
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1);
  });
});
