import { Client } from "pg";

export type Violation = { invariant: string; database: string; rows: unknown[] };

export type InvariantOpts = {
  pgBase: string;
  /** Skip the Kafka DLQ invariant (Task 3). Lets the pg-only tests run without a broker. */
  skipDlq?: boolean;
};

type Check = { name: string; database: string; sql: string };

// Every query returns the OFFENDING rows. Zero rows = the invariant holds.
// Deliberately NOT included, because the database already enforces them and a
// check that cannot fail proves nothing: duplicate Payment per orderId
// (Payment.orderId is @unique) and duplicate ProcessedEvent per eventId
// (eventId is the @id). The real risk in both cases is a mishandled duplicate,
// which INV5 catches by looking at the DLQ instead.
const CHECKS: Check[] = [
  {
    name: "INV1_ORDER_TERMINAL",
    database: "order",
    sql: `SELECT id, status FROM "Order" WHERE status IN ('PENDING','AWAITING_PAYMENT')`,
  },
  {
    name: "INV3_RESERVATION_SPLIT",
    database: "inventory",
    sql: `SELECT "orderId"
            FROM "Reservation"
           GROUP BY "orderId"
          HAVING COUNT(*) FILTER (WHERE status = 'CONSUMED') > 0
             AND COUNT(*) FILTER (WHERE status = 'RELEASED') > 0`,
  },
];

// INV4 runs against every outbox-owning database — 7 of them, gateway has none.
const OUTBOX_DATABASES = [
  "hello",
  "inventory",
  "order",
  "payment",
  "catalog",
  "notification",
  "identity",
];

async function query(url: string, sql: string): Promise<unknown[]> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query(sql);
    return r.rows;
  } finally {
    await c.end();
  }
}

export async function runInvariants(opts: InvariantOpts): Promise<Violation[]> {
  const violations: Violation[] = [];

  for (const check of CHECKS) {
    const rows = await query(`${opts.pgBase}/${check.database}`, check.sql);
    if (rows.length > 0)
      violations.push({ invariant: check.name, database: check.database, rows });
  }

  for (const db of OUTBOX_DATABASES) {
    const rows = await query(
      `${opts.pgBase}/${db}`,
      `SELECT id, type, "occurredAt" FROM "Outbox" WHERE "sentAt" IS NULL`
    );
    if (rows.length > 0)
      violations.push({ invariant: "INV4_OUTBOX_UNSENT", database: db, rows });
  }

  // Cross-service: these read two databases, so they cannot be table-driven like CHECKS.
  // Read the id sets and intersect in memory — the databases are separate servers'
  // logical DBs with no cross-database join available.
  const cancelled = (await query(
    `${opts.pgBase}/order`,
    `SELECT id FROM "Order" WHERE status = 'CANCELLED'`
  )) as { id: string }[];
  const confirmed = (await query(
    `${opts.pgBase}/order`,
    `SELECT id FROM "Order" WHERE status = 'CONFIRMED'`
  )) as { id: string }[];
  const succeeded = new Set(
    (
      (await query(
        `${opts.pgBase}/payment`,
        `SELECT "orderId" FROM "Payment" WHERE status = 'SUCCEEDED'`
      )) as { orderId: string }[]
    ).map((r) => r.orderId)
  );

  const paidButCancelled = cancelled.filter((o) => succeeded.has(o.id));
  if (paidButCancelled.length > 0)
    violations.push({
      invariant: "INV2_CANCELLED_BUT_PAID",
      database: "order+payment",
      rows: paidButCancelled,
    });

  const confirmedUnpaid = confirmed.filter((o) => !succeeded.has(o.id));
  if (confirmedUnpaid.length > 0)
    violations.push({
      invariant: "INV6_CONFIRMED_INCOMPLETE",
      database: "order+payment",
      rows: confirmedUnpaid,
    });

  return violations;
}
