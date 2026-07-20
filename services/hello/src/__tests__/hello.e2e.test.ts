import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { outboxPort } from "../outbox-adapter";
import { handleEvent } from "../consumer";
import { prisma } from "../db";
import {
  createKafka,
  createProducer,
  createConsumer,
  startOutboxRelay,
  getRedis,
} from "@ecom/shared";
import { makeEnvelope, HELLO_CREATED } from "@ecom/contracts";

const TOPIC = "hello.events";

describe("hello tracer bullet (e2e — needs docker compose up + migrated)", () => {
  const kafka = createKafka("hello-e2e");
  const producer = createProducer(kafka);
  const consumer = createConsumer(kafka, `hello-e2e-${Date.now()}`);
  let relay: { stop: () => void };

  beforeAll(async () => {
    await producer.connect();
    relay = startOutboxRelay(outboxPort, producer, () => TOPIC, { intervalMs: 300 });

    // Pre-create the topic via the admin API before subscribing. Without
    // this, consumer.run() below (against a topic the relay has not yet
    // produced to) hits KafkaJS's documented auto-create race on freshly
    // created topics — the metadata response can advertise a leader before
    // the broker's replica manager has caught up, so the next request fails
    // with a retriable UNKNOWN_TOPIC_OR_PARTITION that KafkaJS's
    // Cluster.addMultipleTargetTopics does not itself retry (see Task 8's
    // kafka.int.test.ts for the same fix). Idempotent — a no-op if the topic
    // already exists. Also closer to production, where topics are
    // provisioned ahead of time.
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic: TOPIC, numPartitions: 1, replicationFactor: 1 }],
    });
    await admin.disconnect();

    await consumer.connect();
    await consumer.run([TOPIC], handleEvent);
  });

  afterAll(async () => {
    relay.stop();
    await consumer.disconnect();
    await producer.disconnect();
    (await getRedis()).quit();
    await prisma.$disconnect();
  });

  it("POST /hello flows through outbox -> kafka -> processed exactly once", async () => {
    const res = await request(createApp()).post("/hello").send({ name: "ada" });
    expect(res.status).toBe(201);
    const helloId: string = res.body.helloId;

    // the outbox row id IS the eventId; wait for the consumer to record it
    const deadline = Date.now() + 20_000;
    let processed = null as null | { eventId: string };
    while (!processed && Date.now() < deadline) {
      processed = await prisma.processedEvent.findUnique({ where: { eventId: helloId } });
      if (!processed) await new Promise((r) => setTimeout(r, 400));
    }
    expect(processed).not.toBeNull();

    // idempotency: re-processing the same event does not create a second row
    const count = await prisma.processedEvent.count({ where: { eventId: helloId } });
    expect(count).toBe(1);

    // Real redelivery, exercising both dedup guard layers (the count check
    // above is tautological on its own — ProcessedEvent.eventId is the PK, so
    // it's always 0-or-1 without ever proving a redelivered event is deduped).
    const env = makeEnvelope({
      eventId: helloId,
      type: HELLO_CREATED,
      version: 1,
      traceId: "e2e-redeliver",
      producer: "hello",
      payload: { helloId, name: "ada" },
    });

    // redelivery 1 — Redis fast-path dedup (idem key still present): must not
    // throw, count stays 1
    await handleEvent(env);
    expect(await prisma.processedEvent.count({ where: { eventId: helloId } })).toBe(1);

    // redelivery 2 — evict the Redis idem key, exercising the ProcessedEvent
    // unique-constraint (P2002) backstop: must not throw, count stays 1
    await (await getRedis()).del(`idem:${helloId}`);
    await handleEvent(env);
    expect(await prisma.processedEvent.count({ where: { eventId: helloId } })).toBe(1);
  });
});
