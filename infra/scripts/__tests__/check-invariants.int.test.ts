import { describe, it, expect, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { runInvariants } from "../check-invariants";

// 5432 is what docker-compose.example.yml publishes. Override with PGBASE when the stack is
// remapped (a machine where something else already holds 5432).
const PG = process.env.PGBASE ?? "postgresql://ecom:ecom@localhost:5432";

// Mirrors the checker's own OUTBOX_DATABASES (infra/scripts/check-invariants.ts) — kept as a
// separate literal here on purpose. The whole point of Important-2's fix is a test that would
// fail if the checker's list were wrong, so the test cannot derive its expectation from the
// same list it's supposed to be checking.
const OUTBOX_DATABASES = [
  "hello",
  "inventory",
  "order",
  "payment",
  "catalog",
  "notification",
  "identity",
];

async function sql(db: string, text: string, params: unknown[] = []) {
  const c = new Client({ connectionString: `${PG}/${db}` });
  await c.connect();
  try {
    return await c.query(text, params);
  } finally {
    await c.end();
  }
}

// Each test seeds exactly one violation and asserts the checker reports it.
// Every one of these must fail if its invariant's query is deleted — that is
// the point of the suite, and Global Constraint 1.
describe("invariant checker — single-database invariants (integration)", () => {
  const tag = randomUUID().slice(0, 8);

  afterAll(async () => {
    // Payments before orders, and the order-id list must be fetched from the `order`
    // database first: "order" and "payment" are separate Postgres databases on the same
    // server, so a subselect against "Order" cannot run inside a query against `payment`
    // (no cross-database join). Fetch the tagged ids, then delete payments by id, then
    // delete the orders — reversing the last two steps leaves payment rows behind that
    // fail the next run's clean-baseline test.
    const taggedOrders = await sql(
      "order",
      `SELECT id FROM "Order" WHERE "userId" = $1`,
      [`inv-${tag}`]
    );
    const taggedOrderIds = taggedOrders.rows.map((r) => (r as { id: string }).id);
    if (taggedOrderIds.length > 0) {
      await sql("payment", `DELETE FROM "Payment" WHERE "orderId" = ANY($1::text[])`, [
        taggedOrderIds,
      ]);
    }
    await sql("order", `DELETE FROM "Order" WHERE "userId" = $1`, [`inv-${tag}`]);
    await sql("inventory", `DELETE FROM "Reservation" WHERE "orderId" LIKE $1`, [
      `inv-${tag}%`,
    ]);
    for (const db of OUTBOX_DATABASES) {
      await sql(db, `DELETE FROM "Outbox" WHERE producer = $1`, [`inv-${tag}`]);
    }
  });

  it("clean system reports no violations", async () => {
    const v = await runInvariants({ pgBase: PG, skipDlq: true });
    expect(v).toEqual([]);
  });

  it("INV1: flags orders stuck in AWAITING_PAYMENT and in PENDING", async () => {
    // Both non-terminal states in CHECKS[0].sql's IN (...) list get their own seeded row.
    // Asserting only the invariant name showed up (as the original test did) would still pass
    // if the query narrowed to a single status — asserting each seeded id is among the
    // reported rows is what actually exercises both arms.
    const awaitingId = randomUUID();
    const pendingId = randomUUID();
    await sql(
      "order",
      `INSERT INTO "Order" (id, "userId", status, "totalPrice", "createdAt", "updatedAt")
       VALUES ($1, $2, 'AWAITING_PAYMENT', 100, now(), now())`,
      [awaitingId, `inv-${tag}`]
    );
    await sql(
      "order",
      `INSERT INTO "Order" (id, "userId", status, "totalPrice", "createdAt", "updatedAt")
       VALUES ($1, $2, 'PENDING', 100, now(), now())`,
      [pendingId, `inv-${tag}`]
    );
    const v = await runInvariants({ pgBase: PG, skipDlq: true });
    const inv1 = v.find((x) => x.invariant === "INV1_ORDER_TERMINAL");
    expect(inv1).toBeDefined();
    const flaggedIds = (inv1!.rows as Array<{ id: string }>).map((r) => r.id);
    expect(flaggedIds).toContain(awaitingId);
    expect(flaggedIds).toContain(pendingId);
  });

  it("INV3: flags one order whose reservations split CONSUMED and RELEASED", async () => {
    const orderId = `inv-${tag}-split`;
    for (const status of ["CONSUMED", "RELEASED"]) {
      await sql(
        "inventory",
        `INSERT INTO "Reservation" (id, "orderId", "productId", quantity, status, "expiresAt", "createdAt")
         VALUES ($1, $2, $3, 1, $4, now() + interval '1 hour', now())`,
        [randomUUID(), orderId, `p-${tag}`, status]
      );
    }
    const v = await runInvariants({ pgBase: PG, skipDlq: true });
    expect(v.map((x) => x.invariant)).toContain("INV3_RESERVATION_SPLIT");
  });

  // One row per outbox-owning database, not just `order` — a check that only ever exercises
  // 1 of the 7 databases in OUTBOX_DATABASES would not notice one of the other 6 being dropped
  // or typo'd. Each iteration is scoped to its own db, so cumulative rows left by earlier
  // iterations (cleaned up in afterAll, not between iterations) never leak into a later
  // iteration's assertion.
  it.each(OUTBOX_DATABASES)("INV4: flags an outbox row left unsent in %s", async (db) => {
    const id = randomUUID();
    await sql(
      db,
      `INSERT INTO "Outbox" (id, "aggregateType", "aggregateId", type, version, "traceId", producer, payload, "occurredAt")
       VALUES ($1, 'order', $2, 'order.placed', 1, 't', $3, '{}'::jsonb, now())`,
      [id, `inv-${tag}`, `inv-${tag}`]
    );
    const v = await runInvariants({ pgBase: PG, skipDlq: true });
    const hit = v.find((x) => x.invariant === "INV4_OUTBOX_UNSENT" && x.database === db);
    expect(hit).toBeDefined();
    const flaggedIds = (hit!.rows as Array<{ id: string }>).map((r) => r.id);
    expect(flaggedIds).toContain(id);
  });

  it("INV2: flags an order CANCELLED while its payment SUCCEEDED", async () => {
    const orderId = randomUUID();
    await sql(
      "order",
      `INSERT INTO "Order" (id, "userId", status, "totalPrice", "createdAt", "updatedAt")
       VALUES ($1, $2, 'CANCELLED', 100, now(), now())`,
      [orderId, `inv-${tag}`]
    );
    await sql(
      "payment",
      `INSERT INTO "Payment" (id, "orderId", amount, status, "createdAt", "updatedAt")
       VALUES ($1, $2, 100, 'SUCCEEDED', now(), now())`,
      [randomUUID(), orderId]
    );
    const v = await runInvariants({ pgBase: PG, skipDlq: true });
    // Asserting only that the invariant name showed up (as this test used to) would still pass
    // against an implementation that fires whenever ANY cancelled order and ANY succeeded
    // payment exist anywhere, with no id matching at all — already true on this dev DB (611
    // preserved CANCELLED orders, plus real SUCCEEDED payments) with or without this fixture.
    // Asserting the seeded id is among the reported rows is what actually exercises the
    // order<->payment intersection.
    const inv2 = v.find((x) => x.invariant === "INV2_CANCELLED_BUT_PAID");
    expect(inv2).toBeDefined();
    const flaggedIds = (inv2!.rows as Array<{ id: string }>).map((r) => r.id);
    expect(flaggedIds).toContain(orderId);
  });

  it("INV6: flags a CONFIRMED order with no SUCCEEDED payment", async () => {
    const noPaymentId = randomUUID();
    const failedPaymentId = randomUUID();
    await sql(
      "order",
      `INSERT INTO "Order" (id, "userId", status, "totalPrice", "createdAt", "updatedAt")
       VALUES ($1, $2, 'CONFIRMED', 100, now(), now())`,
      [noPaymentId, `inv-${tag}`]
    );
    await sql(
      "order",
      `INSERT INTO "Order" (id, "userId", status, "totalPrice", "createdAt", "updatedAt")
       VALUES ($1, $2, 'CONFIRMED', 100, now(), now())`,
      [failedPaymentId, `inv-${tag}`]
    );
    // A CONFIRMED order whose only Payment row is FAILED (not SUCCEEDED) must still be flagged.
    // A regression that checks "order has any Payment row" instead of "order has a SUCCEEDED
    // Payment row" would sail through the no-payment-at-all case above while missing this one.
    await sql(
      "payment",
      `INSERT INTO "Payment" (id, "orderId", amount, status, "createdAt", "updatedAt")
       VALUES ($1, $2, 100, 'FAILED', now(), now())`,
      [randomUUID(), failedPaymentId]
    );
    const v = await runInvariants({ pgBase: PG, skipDlq: true });
    // As with INV2, checking only that the invariant name appeared would still pass against an
    // implementation that fires on any non-empty `confirmed` list — true today regardless of this
    // fixture (375 pre-existing INV6 violations on this dev DB; see Known/out-of-scope below).
    // Asserting both seeded ids are among the reported rows is what actually exercises the fix.
    const inv6 = v.find((x) => x.invariant === "INV6_CONFIRMED_INCOMPLETE");
    expect(inv6).toBeDefined();
    const flaggedIds = (inv6!.rows as Array<{ id: string }>).map((r) => r.id);
    expect(flaggedIds).toContain(noPaymentId);
    expect(flaggedIds).toContain(failedPaymentId);
  });
});
