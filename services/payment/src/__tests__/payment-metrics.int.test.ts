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
    await prisma.$disconnect();
  });

  it("SUCCEEDED: a plain amount records exactly one succeeded attempt", async () => {
    await handleChargePayment(chargeCmd(`o_${randomUUID()}`, 500));
    expect(calls).toEqual(["succeeded"]);
  });

  it("FAILED: a ...01 amount records exactly one failed attempt", async () => {
    await handleChargePayment(chargeCmd(`o_${randomUUID()}`, 101));
    expect(calls).toEqual(["failed"]);
  });

  it("PROCESSING: a ...99 amount records exactly one processing attempt", async () => {
    await handleChargePayment(chargeCmd(`o_${randomUUID()}`, 199));
    expect(calls).toEqual(["processing"]);
  });

  it("DUPLICATE: a redelivered command records nothing on the second delivery", async () => {
    const cmd = chargeCmd(`o_${randomUUID()}`, 500);
    await handleChargePayment(cmd);
    expect(calls).toEqual(["succeeded"]);

    calls = [];
    await handleChargePayment(cmd); // same eventId => redelivery
    expect(calls).toEqual([]);
  });

  it("ALREADY_CHARGED: a re-sent command under a new eventId records nothing", async () => {
    const orderId = `o_${randomUUID()}`;
    await handleChargePayment(chargeCmd(orderId, 500));
    expect(calls).toEqual(["succeeded"]);

    calls = [];
    await handleChargePayment(chargeCmd(orderId, 500)); // different eventId, same order
    expect(calls).toEqual([]);
  });
});
