import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { outboxPort } from "../outbox-adapter";
import { handleOrderEvent } from "../consumer";
import { makeHandleSendEmail } from "../worker";
import { createMailer } from "../mailer";
import { prisma } from "../db";
import { SEND_EMAIL } from "../commands";
import {
  createKafka,
  createProducer,
  createConsumer,
  startOutboxRelay,
  createRabbit,
} from "@ecom/shared";
import { makeEnvelope, ORDER_CONFIRMED } from "@ecom/contracts";

const ORDER_TOPIC = "order.events";
// Isolated queue per run so a leftover DLQ/backlog from another suite can't bleed in.
const QUEUE = `notifications.e2e.${Date.now()}`;
const MAILPIT_API = process.env.MAILPIT_API ?? "http://localhost:8025";

async function waitFor(
  cond: () => Promise<boolean>,
  timeoutMs: number,
  stepMs = 250
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error("waitFor timed out");
}

describe("notification e2e (needs compose up + migrated + mailpit)", () => {
  const kafka = createKafka("notification-e2e");
  const producer = createProducer(kafka);
  const consumer = createConsumer(kafka, `notification-e2e-${Date.now()}`);
  let rabbit: Awaited<ReturnType<typeof createRabbit>>;
  let relay: { stop: () => void };

  beforeAll(async () => {
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic: ORDER_TOPIC, numPartitions: 1, replicationFactor: 1 }],
    });
    await admin.disconnect();

    await producer.connect();
    rabbit = await createRabbit({ prefetch: 5 });
    await rabbit.assertWorkQueue(QUEUE);
    relay = startOutboxRelay(outboxPort, producer, (t) => `${t}.events`, {
      intervalMs: 300,
      commands: {
        sender: rabbit,
        queueFor: (r) => (r.type === SEND_EMAIL ? QUEUE : null),
      },
    });

    // Dispatcher leg (Kafka) and worker leg (Rabbit -> mailpit) both run in-process.
    await consumer.connect();
    await consumer.run([ORDER_TOPIC], handleOrderEvent);
    const mailer = createMailer({
      host: process.env.SMTP_HOST ?? "localhost",
      port: Number(process.env.SMTP_PORT ?? 1025),
    });
    await rabbit.consumeCommands(QUEUE, makeHandleSendEmail(mailer), { maxRetries: 3 });
  }, 60_000);

  afterAll(async () => {
    relay.stop();
    await consumer.disconnect();
    await rabbit.close();
    await producer.disconnect();
    await prisma.$disconnect();
  });

  it("order.confirmed -> Notification SENT -> email in mailpit", async () => {
    const orderId = `o_${randomUUID()}`;
    const userId = `u_${randomUUID()}`;
    await producer.publish(
      ORDER_TOPIC,
      makeEnvelope({
        type: ORDER_CONFIRMED,
        version: 1,
        traceId: "t",
        producer: "order",
        payload: { orderId, userId },
      })
    );

    await waitFor(
      async () =>
        (await prisma.notification.findFirst({ where: { orderId } }))?.status === "SENT",
      30_000
    );

    const row = await prisma.notification.findFirst({ where: { orderId } });
    expect(row?.to).toBe(`${userId}@example.test`);
    expect(row?.sentAt).not.toBeNull();

    const res = await fetch(`${MAILPIT_API}/api/v1/search?query=${userId}`);
    const body = (await res.json()) as { messages?: Array<{ Subject: string }> };
    expect(body.messages?.length ?? 0).toBeGreaterThan(0);
    expect(body.messages![0].Subject).toContain(orderId);
  }, 60_000);
});
