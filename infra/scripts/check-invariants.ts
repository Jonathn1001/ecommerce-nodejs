import { Client } from "pg";
import { Kafka } from "kafkajs";
import amqp from "amqplib";

export type Violation = { invariant: string; database: string; rows: unknown[] };

export type InvariantOpts = {
  pgBase: string;
  /** Skip the DLQ invariant. Lets the pg-only tests run without a broker. */
  skipDlq?: boolean;
  brokers?: string[];
  rabbitUrl?: string;
  /** Poll until nothing is in flight, or fail reporting what still was. */
  waitForDrainSeconds?: number;
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

// INV5 has two sources because the platform has two transports. Only topics somebody
// actually CONSUMES can ever have a DLQ — the park happens in the consumer
// (packages/shared/src/kafka.ts:179, `${topic}.dlq`) — so this list is the set of consumed
// topics, not the set of published ones: hello.events (services/hello/src/main.ts:33),
// order.events (inventory:43 and notification:44), inventory.events + payment.events
// (order:51), catalog.events (order:61). notification.events and identity.events are
// deliberately absent: nothing consumes them, so a DLQ for them cannot exist, and a check
// that cannot fire proves nothing.
export const KAFKA_DLQ_TOPICS = [
  "hello.events.dlq",
  "order.events.dlq",
  "inventory.events.dlq",
  "payment.events.dlq",
  "catalog.events.dlq",
];

// The Rabbit half. Queue names come from the services that assert them:
// payment.charge (services/payment/src/main.ts:20,35) and notifications
// (services/notification/src/main.ts:24). assertWorkQueue creates `${queue}.dlq`
// (packages/shared/src/rabbitmq.ts:94-97).
const RABBIT_DLQ_QUEUES = ["payment.charge.dlq", "notifications.dlq"];

// Depth = high watermark - low watermark. A truncated topic has high == low and
// reads as empty, which is what reset-dev-topics.sh leaves behind.
async function kafkaDlqDepths(
  brokers: string[]
): Promise<{ topic: string; depth: number }[]> {
  const admin = new Kafka({ clientId: "invariant-checker", brokers }).admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const out: { topic: string; depth: number }[] = [];
    for (const topic of KAFKA_DLQ_TOPICS) {
      if (!existing.has(topic)) continue; // never created = never parked
      const parts = await admin.fetchTopicOffsets(topic);
      const depth = parts.reduce((n, p) => n + (Number(p.high) - Number(p.low)), 0);
      if (depth > 0) out.push({ topic, depth });
    }
    return out;
  } finally {
    await admin.disconnect();
  }
}

// DEVIATION from spec §A1a, which says the Rabbit half reuses packages/shared's queueDepth
// helper: infra/ is deliberately not a pnpm workspace member (that is what makes
// `typecheck:infra` a separate gate), so it cannot import @ecom/shared at all. amqplib is
// used directly for the same reason the Postgres side uses raw `pg` rather than Prisma —
// this is an out-of-band operator tool, not a service. The careful channel-lifecycle
// handling in shared's queueDepth exists because that helper shares a connection with the
// relay's command lane; here the checker owns the connection and closes it, so a
// channel-level death cannot take anything else down with it.
async function rabbitDlqDepths(url: string): Promise<{ queue: string; depth: number }[]> {
  const conn = await amqp.connect(url);
  try {
    const out: { queue: string; depth: number }[] = [];
    for (const queue of RABBIT_DLQ_QUEUES) {
      // checkQueue closes the channel it runs on when the queue is missing, so each check
      // gets its own channel. A missing queue means the service never started here, which
      // is "never parked", not a violation.
      const ch = await conn.createChannel();
      ch.on("error", () => {}); // amqplib re-emits the 404 as a channel 'error'; unhandled it throws
      try {
        const info = await ch.checkQueue(queue);
        if (info.messageCount > 0) out.push({ queue, depth: info.messageCount });
        await ch.close();
      } catch {
        /* missing queue: the channel is already closed, nothing to release */
      }
    }
    return out;
  } finally {
    await conn.close();
  }
}

// "In flight" = the two things that make INV1 and INV4 premature: an order that has
// not settled, and an outbox row the relay has not published. Both must be zero
// before those invariants mean anything.
async function inFlightCount(pgBase: string): Promise<number> {
  const orders = (await query(
    `${pgBase}/order`,
    `SELECT count(*)::int AS n FROM "Order" WHERE status IN ('PENDING','AWAITING_PAYMENT')`
  )) as { n: number }[];

  let unsent = 0;
  for (const db of OUTBOX_DATABASES) {
    const r = (await query(
      `${pgBase}/${db}`,
      `SELECT count(*)::int AS n FROM "Outbox" WHERE "sentAt" IS NULL`
    )) as { n: number }[];
    unsent += r[0].n;
  }
  // The ::int casts above are load-bearing: count(*) is a bigint, which pg hands back as a
  // STRING, so the un-cast version concatenates instead of summing and never reaches zero.
  return orders[0].n + unsent;
}

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

  // INV1 and INV4 are only meaningful once the system has settled. Without this a
  // chaos run fails merely for checking too early, and the suite becomes untrustworthy
  // in exactly the scenario it exists for. A timeout is a REPORTED FAILURE carrying
  // what was still in flight — never a silent pass and never a hang.
  if (opts.waitForDrainSeconds) {
    const deadline = Date.now() + opts.waitForDrainSeconds * 1000;
    for (;;) {
      const inFlight = await inFlightCount(opts.pgBase);
      if (inFlight === 0) break;
      if (Date.now() >= deadline) {
        violations.push({
          invariant: "DRAIN_TIMEOUT",
          database: "order+outboxes",
          rows: [{ inFlight, waitedSeconds: opts.waitForDrainSeconds }],
        });
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

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

  // One INV5 violation per transport rather than one merged entry: the transport is where
  // an operator has to go to look, and it keeps the violation SET a chaos scenario asserts
  // on (`exactly [INV5_DLQ_NOT_EMPTY]`) unchanged either way.
  if (!opts.skipDlq) {
    const kafkaDepths = await kafkaDlqDepths(opts.brokers ?? ["localhost:9092"]);
    if (kafkaDepths.length > 0)
      violations.push({
        invariant: "INV5_DLQ_NOT_EMPTY",
        database: "kafka",
        rows: kafkaDepths,
      });

    const rabbitDepths = await rabbitDlqDepths(
      opts.rabbitUrl ?? process.env.RABBITMQ_URL ?? "amqp://ecom:ecom@localhost:5672"
    );
    if (rabbitDepths.length > 0)
      violations.push({
        invariant: "INV5_DLQ_NOT_EMPTY",
        database: "rabbit",
        rows: rabbitDepths,
      });
  }

  return violations;
}
