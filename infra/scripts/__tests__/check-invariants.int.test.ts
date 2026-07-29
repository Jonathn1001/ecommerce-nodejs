import { describe, it, expect, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { runInvariants } from "../check-invariants";

const PG = process.env.PGBASE ?? "postgresql://ecom:ecom@localhost:5433";

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
    await sql("order", `DELETE FROM "Order" WHERE "userId" = $1`, [`inv-${tag}`]);
    await sql("order", `DELETE FROM "Outbox" WHERE producer = $1`, [`inv-${tag}`]);
    await sql("inventory", `DELETE FROM "Reservation" WHERE "orderId" LIKE $1`, [
      `inv-${tag}%`,
    ]);
  });

  it("clean system reports no violations", async () => {
    const v = await runInvariants({ pgBase: PG, skipDlq: true });
    expect(v).toEqual([]);
  });

  it("INV1: flags an order stuck in a non-terminal state", async () => {
    await sql(
      "order",
      `INSERT INTO "Order" (id, "userId", status, "totalPrice", "createdAt", "updatedAt")
       VALUES ($1, $2, 'AWAITING_PAYMENT', 100, now(), now())`,
      [randomUUID(), `inv-${tag}`]
    );
    const v = await runInvariants({ pgBase: PG, skipDlq: true });
    expect(v.map((x) => x.invariant)).toContain("INV1_ORDER_TERMINAL");
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

  it("INV4: flags an outbox row left unsent", async () => {
    await sql(
      "order",
      `INSERT INTO "Outbox" (id, "aggregateType", "aggregateId", type, version, "traceId", producer, payload, "occurredAt")
       VALUES ($1, 'order', $2, 'order.placed', 1, 't', $3, '{}'::jsonb, now())`,
      [randomUUID(), `inv-${tag}`, `inv-${tag}`]
    );
    const v = await runInvariants({ pgBase: PG, skipDlq: true });
    expect(v.map((x) => x.invariant)).toContain("INV4_OUTBOX_UNSENT");
  });
});
