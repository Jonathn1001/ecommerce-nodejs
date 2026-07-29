import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { handleOrderEvent, setReservationMetrics } from "../consumer";
import { prisma } from "../db";
import { makeEnvelope, ORDER_PLACED } from "@ecom/contracts";

// The brief's own reservation-metrics.unit.test.ts constructs the counter directly
// and asserts on it — that verifies metrics.ts, but it never calls handlePlaced, so
// it would pass identically whether or not consumer.ts actually wired
// reservation.observe(outcome) into the reserveOrder seam (or wired it to the wrong
// outcome, or inside the transaction callback). These tests drive handleOrderEvent
// itself, against the real transaction, to pin that property.

async function seed(productId: string, available: number) {
  await prisma.inventory.upsert({
    where: { productId },
    create: { productId, available },
    update: { available },
  });
}

function placed(orderId: string, items: Array<{ productId: string; quantity: number }>) {
  return makeEnvelope({
    type: ORDER_PLACED,
    version: 1,
    traceId: "t",
    producer: "test",
    payload: { orderId, userId: "u1", items },
  });
}

let calls: string[];

beforeEach(() => {
  calls = [];
  setReservationMetrics({ observe: (outcome) => calls.push(outcome) });
});

describe("reservation metrics recording via handleOrderEvent (integration — needs compose up + migrated)", () => {
  afterAll(async () => {
    setReservationMetrics({ observe: () => {} });
    await prisma.$disconnect();
  });

  it("RESERVED: a satisfiable order records exactly one RESERVED outcome", async () => {
    const p1 = `p_${randomUUID()}`;
    const orderId = `o_${randomUUID()}`;
    await seed(p1, 5);

    await handleOrderEvent(placed(orderId, [{ productId: p1, quantity: 2 }]));

    expect(calls).toEqual(["RESERVED"]);
  });

  it("FAILED: insufficient stock records exactly one FAILED outcome", async () => {
    const p1 = `p_${randomUUID()}`;
    const orderId = `o_${randomUUID()}`;
    await seed(p1, 1);

    await handleOrderEvent(placed(orderId, [{ productId: p1, quantity: 3 }]));

    expect(calls).toEqual(["FAILED"]);
  });

  it("DUPLICATE: a redelivered event records DUPLICATE on the second delivery only", async () => {
    const p1 = `p_${randomUUID()}`;
    const orderId = `o_${randomUUID()}`;
    await seed(p1, 5);
    const env = placed(orderId, [{ productId: p1, quantity: 1 }]);

    await handleOrderEvent(env);
    expect(calls).toEqual(["RESERVED"]);

    calls = [];
    await handleOrderEvent(env); // same eventId => redelivery
    expect(calls).toEqual(["DUPLICATE"]);
  });

  it("a transaction that rolls back (DB-level failure, not a business FAILED) records nothing", async () => {
    const p1 = `p_${randomUUID()}`;
    const orderId = `o_${randomUUID()}`;
    await seed(p1, 5);

    // Simulate the transaction itself rejecting (e.g. a connection drop or a
    // constraint violation) rather than reserveOrder returning "FAILED". This is
    // the case the brief warns about: recording must sit after the resolved
    // await, so a rejection here must never reach reservation.observe. Prisma's
    // client methods are proxy-backed (see the order-service saga-metrics.int
    // test), so reassign-and-restore by hand rather than vi.spyOn.
    const originalTransaction = prisma.$transaction.bind(prisma);
    (prisma as unknown as { $transaction: unknown }).$transaction = () =>
      Promise.reject(new Error("simulated rollback"));
    try {
      await expect(
        handleOrderEvent(placed(orderId, [{ productId: p1, quantity: 1 }]))
      ).rejects.toThrow("simulated rollback");
    } finally {
      (prisma as unknown as { $transaction: unknown }).$transaction = originalTransaction;
    }

    expect(calls).toEqual([]);
  });
});
