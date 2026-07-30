import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { handleEvent, setSagaMetrics } from "../consumer";
import { prisma } from "../db";
import {
  makeEnvelope,
  INVENTORY_RESERVED,
  INVENTORY_RESERVATION_FAILED,
  PAYMENT_SUCCEEDED,
  PAYMENT_FAILED,
  type EventEnvelope,
} from "@ecom/contracts";

// The brief's own saga-metrics.unit.test.ts gating test drives applyResult directly,
// which never touches saga metrics by design (recording lives in the caller). That
// test therefore cannot discriminate the actual outcome-gating logic added to
// handleEvent in consumer.ts — it would pass identically whether or not that gating
// were implemented correctly (or at all). These tests exercise handleEvent itself,
// against the real transaction, to pin the property that matters.

// Tag every order this file seeds so afterAll can find and delete them by a DB
// query, not an in-memory id list — a mid-suite throw still gets cleaned up.
// Several tests drive handleEvent with a fake PaymentSucceeded straight into the
// order database, landing orders in CONFIRMED with no Payment row behind them at
// all — a state the real system cannot produce. Left uncleaned, that trips
// INV6_CONFIRMED_INCOMPLETE on every run.
const TEST_TAG = "test-saga-metrics-int";

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

type Call = { kind: "step" | "saga"; label: string };

let calls: Call[];

beforeEach(() => {
  calls = [];
  setSagaMetrics({
    observeStep: (step) => calls.push({ kind: "step", label: step }),
    observeSaga: (outcome) => calls.push({ kind: "saga", label: outcome }),
  });
});

describe("saga metrics recording via handleEvent (integration — needs compose up + migrated)", () => {
  afterAll(async () => {
    setSagaMetrics({ observeStep: () => {}, observeSaga: () => {} });
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

  it("PENDING -> AWAITING_PAYMENT records a reserve step and no saga total", async () => {
    const id = await seedOrder("PENDING", 700);
    await handleEvent(
      env(INVENTORY_RESERVED, id, {
        orderId: id,
        items: [{ productId: "p1", quantity: 1 }],
      })
    );
    expect(calls).toEqual([{ kind: "step", label: "reserve" }]);
  });

  it("PENDING -> CANCELLED (reservation failure) records a reserve step and a cancelled saga", async () => {
    const id = await seedOrder("PENDING", 700);
    await handleEvent(
      env(INVENTORY_RESERVATION_FAILED, id, { orderId: id, reason: "OOS" })
    );
    expect(calls).toEqual([
      { kind: "step", label: "reserve" },
      { kind: "saga", label: "cancelled" },
    ]);
  });

  it("AWAITING_PAYMENT -> CONFIRMED records a payment step and a confirmed saga", async () => {
    const id = await seedOrder("AWAITING_PAYMENT");
    await handleEvent(
      env(PAYMENT_SUCCEEDED, id, { orderId: id, paymentId: "pay_1", amount: 500 })
    );
    expect(calls).toEqual([
      { kind: "step", label: "payment" },
      { kind: "saga", label: "confirmed" },
    ]);
  });

  it("AWAITING_PAYMENT -> CANCELLED (payment failure) records a payment step and a cancelled saga", async () => {
    const id = await seedOrder("AWAITING_PAYMENT");
    await handleEvent(env(PAYMENT_FAILED, id, { orderId: id, reason: "CARD_DECLINED" }));
    expect(calls).toEqual([
      { kind: "step", label: "payment" },
      { kind: "saga", label: "cancelled" },
    ]);
  });

  it("a redelivered event (DUPLICATE outcome) records nothing on the second delivery", async () => {
    const id = await seedOrder("AWAITING_PAYMENT");
    const e = env(PAYMENT_SUCCEEDED, id, { orderId: id, paymentId: "p", amount: 500 });
    await handleEvent(e);
    expect(calls.length).toBeGreaterThan(0);
    calls = [];
    await handleEvent(e); // redelivery: DUPLICATE
    expect(calls).toEqual([]);
  });

  it("an unknown order (UNKNOWN_ORDER outcome) records nothing", async () => {
    const e = env(PAYMENT_SUCCEEDED, `o_${randomUUID()}`, {
      orderId: "x",
      paymentId: "p",
      amount: 1,
    });
    await handleEvent(e);
    expect(calls).toEqual([]);
  });

  it("a failing advisory pre-read does not block the real transition and records nothing", async () => {
    const id = await seedOrder("PENDING", 700);

    // Prisma's model delegate is proxy-backed; vi.spyOn(...).mockRestore() does not
    // reliably hand the original method back, so save/replace/restore by hand.
    const originalFindUnique = prisma.order.findUnique.bind(prisma.order);
    let readCount = 0;
    (prisma.order as unknown as { findUnique: unknown }).findUnique = (
      args: Parameters<typeof prisma.order.findUnique>[0]
    ) => {
      readCount += 1;
      if (readCount === 1) return Promise.reject(new Error("pool exhausted"));
      return originalFindUnique(args);
    };

    try {
      // The pre-read is metrics-adjacent, not load-bearing. A DB failure on it must
      // not propagate out of handleEvent — the transaction below still has to run.
      await expect(
        handleEvent(
          env(INVENTORY_RESERVED, id, {
            orderId: id,
            items: [{ productId: "p1", quantity: 1 }],
          })
        )
      ).resolves.toBeUndefined();
    } finally {
      (prisma.order as unknown as { findUnique: unknown }).findUnique =
        originalFindUnique;
    }

    expect(calls).toEqual([]); // before stayed null -> the existing gate skips recording
    const after = await prisma.order.findUnique({ where: { id } });
    expect(after?.status).toBe("AWAITING_PAYMENT"); // the real transition still happened
  });
});
