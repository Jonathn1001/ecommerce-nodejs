import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { handleChargePayment, setPaymentMetrics } from "../consumer";
import { prisma } from "../db";
import { makeEnvelope, CHARGE_PAYMENT, type EventEnvelope } from "@ecom/contracts";

// payment-metrics.unit.test.ts constructs the counter directly, so it passes whether or
// not consumer.ts wires anything. These cases drive handleChargePayment against the real
// transaction. The last two are the discriminating ones: DUPLICATE and ALREADY_CHARGED are
// idempotency short-circuits, not charge attempts, so a naive
// `payment.observe(outcome.toLowerCase())` would satisfy every other case and still be wrong.
//
// simulateCharge (charge.ts:7-11) picks the outcome from the amount:
//   %100 == 1 -> FAILED, %100 == 99 -> PROCESSING, else SUCCEEDED.

// Tag every orderId this file invents so afterAll can find and delete the rows by a DB
// query, not an in-memory id list — a mid-suite throw still gets cleaned up. Driving the
// real charge path enqueues an outbox row keyed by orderId, and no relay runs during an
// integration test, so it sits unsent and INV4_OUTBOX_UNSENT reports it.
const TEST_TAG = "test-payment-metrics-int";
const taggedOrder = () => `${TEST_TAG}-o-${randomUUID()}`;

function chargeCmd(orderId: string, amount: number): EventEnvelope {
  return makeEnvelope({
    type: CHARGE_PAYMENT,
    version: 1,
    traceId: "t",
    producer: "test",
    payload: { orderId, userId: `u_${randomUUID()}`, amount },
  });
}

let calls: string[];

beforeEach(() => {
  calls = [];
  setPaymentMetrics({ observe: (outcome) => calls.push(outcome) });
});

describe("payment attempt metrics via handleChargePayment (integration — needs compose up + migrated)", () => {
  afterAll(async () => {
    setPaymentMetrics({ observe: () => {} });
    // PaymentAttempt cascades from Payment (onDelete: Cascade in schema.prisma);
    // Outbox has no FK to it, so it is deleted explicitly.
    await prisma.outbox.deleteMany({ where: { aggregateId: { startsWith: TEST_TAG } } });
    await prisma.payment.deleteMany({ where: { orderId: { startsWith: TEST_TAG } } });
    await prisma.$disconnect();
  });

  it("SUCCEEDED: a plain amount records exactly one succeeded attempt", async () => {
    await handleChargePayment(chargeCmd(taggedOrder(), 500));
    expect(calls).toEqual(["succeeded"]);
  });

  it("FAILED: a ...01 amount records exactly one failed attempt", async () => {
    await handleChargePayment(chargeCmd(taggedOrder(), 101));
    expect(calls).toEqual(["failed"]);
  });

  it("PROCESSING: a ...99 amount records exactly one processing attempt", async () => {
    await handleChargePayment(chargeCmd(taggedOrder(), 199));
    expect(calls).toEqual(["processing"]);
  });

  it("DUPLICATE: a redelivered command records nothing on the second delivery", async () => {
    const cmd = chargeCmd(taggedOrder(), 500);
    await handleChargePayment(cmd);
    expect(calls).toEqual(["succeeded"]);

    calls = [];
    await handleChargePayment(cmd); // same eventId => redelivery
    expect(calls).toEqual([]);
  });

  it("ALREADY_CHARGED: a re-sent command under a new eventId records nothing", async () => {
    const orderId = taggedOrder();
    await handleChargePayment(chargeCmd(orderId, 500));
    expect(calls).toEqual(["succeeded"]);

    calls = [];
    await handleChargePayment(chargeCmd(orderId, 500)); // different eventId, same order
    expect(calls).toEqual([]);
  });
});
