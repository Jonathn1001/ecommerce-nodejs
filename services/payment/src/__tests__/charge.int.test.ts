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

// Tag every orderId this file invents so afterAll can find and delete the rows by a
// DB query, not an in-memory id list — a mid-suite throw still gets cleaned up.
// Charging enqueues a PaymentSucceeded/PaymentFailed outbox row keyed by orderId, and
// no relay runs during an integration test, so it sits unsent and INV4_OUTBOX_UNSENT
// reports it. The Payment rows go too: they carry orderIds that exist in no order
// database, which is not a violation today but does inflate the SUCCEEDED set that
// INV2 and INV6 intersect against.
const TEST_TAG = "test-charge-int";
const taggedOrder = () => `${TEST_TAG}-o-${randomUUID()}`;

function chargeCmd(orderId: string, amount: number, userId: string): EventEnvelope {
  return makeEnvelope({
    type: CHARGE_PAYMENT,
    version: 1,
    traceId: "t",
    producer: "test",
    payload: { orderId, userId, amount },
  });
}
// A command minted before this deploy's contract widened — no userId key at all.
function legacyChargeCmd(orderId: string, amount: number): EventEnvelope {
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
const userIdOf = async (orderId: string) =>
  (await prisma.payment.findUnique({ where: { orderId } }))?.userId;

describe("payment charge consumer (integration — needs docker compose up + migrated)", () => {
  afterAll(async () => {
    // PaymentAttempt cascades from Payment (onDelete: Cascade in schema.prisma);
    // Outbox has no FK to it, so it is deleted explicitly.
    await prisma.outbox.deleteMany({
      where: { aggregateId: { startsWith: TEST_TAG } },
    });
    await prisma.payment.deleteMany({ where: { orderId: { startsWith: TEST_TAG } } });
    await prisma.$disconnect();
  });

  it("charges a success amount -> Payment SUCCEEDED + one PaymentSucceeded outbox + one attempt", async () => {
    const orderId = taggedOrder();
    const userId = `u_${randomUUID()}`;
    await handleChargePayment(chargeCmd(orderId, 500, userId));
    expect(await statusOf(orderId)).toBe("SUCCEEDED");
    expect(await userIdOf(orderId)).toBe(userId);
    expect(await outboxCount(orderId, PAYMENT_SUCCEEDED)).toBe(1);
    const pay = await prisma.payment.findUnique({ where: { orderId } });
    expect(await prisma.paymentAttempt.count({ where: { paymentId: pay!.id } })).toBe(1);
  });

  it("declines a ...01 amount -> Payment FAILED + one PaymentFailed outbox", async () => {
    const orderId = taggedOrder();
    const userId = `u_${randomUUID()}`;
    await handleChargePayment(chargeCmd(orderId, 101, userId));
    expect(await statusOf(orderId)).toBe("FAILED");
    expect(await outboxCount(orderId, PAYMENT_FAILED)).toBe(1);
  });

  it("dedupes a redelivered command -> one payment, one ProcessedEvent", async () => {
    const orderId = taggedOrder();
    const cmd = chargeCmd(orderId, 500, `u_${randomUUID()}`);
    await handleChargePayment(cmd);
    await handleChargePayment(cmd); // same eventId
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1);
    expect(await prisma.processedEvent.count({ where: { eventId: cmd.eventId } })).toBe(
      1
    );
  });

  it("re-sent command (new eventId, same order) -> still one payment (ALREADY_CHARGED)", async () => {
    const orderId = taggedOrder();
    const userId = `u_${randomUUID()}`;
    await handleChargePayment(chargeCmd(orderId, 500, userId));
    await handleChargePayment(chargeCmd(orderId, 500, userId)); // different eventId
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1);
  });

  // Controller resolution: a ChargePayment enqueued before this deploy's contract widened
  // has no userId at all. The consumer must not hard-fail on it (that would retry 3x then
  // DLQ the command forever, leaving its order stuck in AWAITING_PAYMENT) — it tolerates
  // the missing field and stores userId as null instead.
  it("a legacy command with no userId is charged normally, storing userId as null", async () => {
    const orderId = taggedOrder();
    await handleChargePayment(legacyChargeCmd(orderId, 500));
    expect(await statusOf(orderId)).toBe("SUCCEEDED");
    expect(await userIdOf(orderId)).toBeNull();
    expect(await outboxCount(orderId, PAYMENT_SUCCEEDED)).toBe(1);
  });
});
