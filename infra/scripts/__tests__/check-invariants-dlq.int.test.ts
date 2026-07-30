import { describe, it, expect, afterAll } from "vitest";
import { Kafka } from "kafkajs";
import { randomUUID } from "crypto";
import { Client } from "pg";
import amqp from "amqplib";
import { runInvariants } from "../check-invariants";

const PG = process.env.PGBASE ?? "postgresql://ecom:ecom@localhost:5432";
const BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",");
const RABBIT_URL = process.env.RABBITMQ_URL ?? "amqp://ecom:ecom@localhost:5672";
const kafka = new Kafka({ clientId: `inv-test-${randomUUID()}`, brokers: BROKERS });

// The two DLQs this file dirties, one per transport. order.events.dlq is a real DLQ —
// inventory and notification both consume order.events — and payment.charge.dlq is the
// Rabbit half, asserted at payment startup (services/payment/src/main.ts:35).
const KAFKA_DLQ = "order.events.dlq";
const RABBIT_DLQ = "payment.charge.dlq";

async function truncateKafkaDlq(): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    if (!(await admin.listTopics()).includes(KAFKA_DLQ)) return;
    const offsets = await admin.fetchTopicOffsets(KAFKA_DLQ);
    await admin.deleteTopicRecords({
      topic: KAFKA_DLQ,
      partitions: offsets.map((p) => ({ partition: p.partition, offset: p.high })),
    });
  } finally {
    await admin.disconnect();
  }
}

async function produceToKafkaDlq(): Promise<void> {
  const producer = kafka.producer();
  await producer.connect();
  try {
    await producer.send({
      topic: KAFKA_DLQ,
      messages: [{ key: randomUUID(), value: "not-a-valid-envelope" }],
    });
  } finally {
    await producer.disconnect();
  }
}

// amqplib directly rather than @ecom/shared's createRabbit: infra/ is not a pnpm workspace
// member, so @ecom/* does not resolve here at all. Same reason the checker itself does.
async function withRabbitChannel<T>(fn: (ch: amqp.Channel) => Promise<T>): Promise<T> {
  const conn = await amqp.connect(RABBIT_URL);
  try {
    const ch = await conn.createChannel();
    ch.on("error", () => {}); // a channel-level close is re-emitted as 'error'; unhandled it throws
    const result = await fn(ch);
    await ch.close();
    return result;
  } finally {
    await conn.close();
  }
}

async function sendToRabbitDlq(): Promise<void> {
  await withRabbitChannel(async (ch) => {
    // Declared exactly as packages/shared/src/rabbitmq.ts:96 declares it, or the assert
    // would be rejected for mismatched arguments against an existing queue.
    await ch.assertQueue(RABBIT_DLQ, { durable: true });
    ch.sendToQueue(
      RABBIT_DLQ,
      Buffer.from(JSON.stringify({ why: "seeded into the DLQ" })),
      {
        persistent: true,
      }
    );
    // sendToQueue does not wait for the broker on a non-confirm channel, so poll until the
    // message is actually countable. Without this the checker could read a depth of 0 and
    // the case would fail for a timing reason rather than a real one.
    for (let i = 0; i < 40; i++) {
      if ((await ch.checkQueue(RABBIT_DLQ)).messageCount > 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("seeded DLQ message never became visible");
  });
}

async function drainRabbitDlq(): Promise<void> {
  await withRabbitChannel(async (ch) => {
    await ch.assertQueue(RABBIT_DLQ, { durable: true });
    await ch.purgeQueue(RABBIT_DLQ);
  });
}

async function sql(db: string, text: string, params: unknown[] = []) {
  const c = new Client({ connectionString: `${PG}/${db}` });
  await c.connect();
  try {
    return await c.query(text, params);
  } finally {
    await c.end();
  }
}

const inv5Of = (v: Awaited<ReturnType<typeof runInvariants>>, database: string) =>
  v.find((x) => x.invariant === "INV5_DLQ_NOT_EMPTY" && x.database === database);

describe("invariant checker — DLQ and drain (integration, needs kafka + rabbit)", () => {
  afterAll(async () => {
    await truncateKafkaDlq();
    await drainRabbitDlq();
  });

  it("INV5: flags a message sitting in a Kafka DLQ topic, naming that topic and its depth", async () => {
    await truncateKafkaDlq();
    await produceToKafkaDlq();

    const v = await runInvariants({ pgBase: PG, brokers: BROKERS });
    const inv5 = inv5Of(v, "kafka");
    expect(inv5).toBeDefined();
    // Asserting the exact seeded topic AND depth, not merely that the invariant fired:
    // any other dirty DLQ topic would satisfy a name-only assertion on this broker.
    expect(inv5!.rows).toContainEqual({ topic: KAFKA_DLQ, depth: 1 });

    await truncateKafkaDlq();
  });

  it("INV5: flags a message sitting in a RabbitMQ DLQ queue, naming that queue and its depth", async () => {
    await drainRabbitDlq();
    await sendToRabbitDlq();

    const v = await runInvariants({ pgBase: PG, brokers: BROKERS });
    const inv5 = inv5Of(v, "rabbit");
    expect(inv5).toBeDefined();
    expect(inv5!.rows).toContainEqual({ queue: RABBIT_DLQ, depth: 1 });

    await drainRabbitDlq();
  });

  // Without this the two cases above would pass against a checker that reports INV5
  // unconditionally, which is the failure mode the Task 1 and Task 2 reviews both found.
  it("reports no INV5 at all once both DLQs are empty", async () => {
    await truncateKafkaDlq();
    await drainRabbitDlq();

    const v = await runInvariants({ pgBase: PG, brokers: BROKERS });
    expect(v.filter((x) => x.invariant === "INV5_DLQ_NOT_EMPTY")).toEqual([]);
  });

  it("DRAIN_TIMEOUT: an outbox row the relay will never send is reported, with what was in flight", async () => {
    const id = randomUUID();
    await sql(
      "order",
      `INSERT INTO "Outbox" ("id","aggregateType","aggregateId","type","traceId","producer","payload","sentAt")
       VALUES ($1,'Order',$2,'test.drain','t','invariant-test','{}'::jsonb, NULL)`,
      [id, `test-drain-${id}`]
    );
    try {
      const started = Date.now();
      const v = await runInvariants({
        pgBase: PG,
        brokers: BROKERS,
        waitForDrainSeconds: 2,
      });
      const timeout = v.find((x) => x.invariant === "DRAIN_TIMEOUT");

      // A drain-wait that gives up silently is indistinguishable from a clean system, so
      // the count is asserted, not just the violation's presence. inFlight must be a
      // NUMBER: count(*) comes back from pg as a string, and the un-cast version would
      // concatenate instead of summing and never reach zero.
      expect(timeout).toBeDefined();
      const row = timeout!.rows[0] as { inFlight: number; waitedSeconds: number };
      expect(typeof row.inFlight).toBe("number");
      expect(row.inFlight).toBeGreaterThanOrEqual(1);
      expect(row.waitedSeconds).toBe(2);
      // ...and it waited rather than short-circuiting, but still returned rather than hanging.
      expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    } finally {
      await sql("order", `DELETE FROM "Outbox" WHERE id = $1`, [id]);
    }
  });

  it("the drain-wait returns without a DRAIN_TIMEOUT when nothing is in flight", async () => {
    const v = await runInvariants({
      pgBase: PG,
      brokers: BROKERS,
      waitForDrainSeconds: 5,
    });
    expect(v.find((x) => x.invariant === "DRAIN_TIMEOUT")).toBeUndefined();
  });
});
