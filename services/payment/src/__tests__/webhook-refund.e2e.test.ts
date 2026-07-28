import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { outboxPort } from "../outbox-adapter";
import { handleChargePayment } from "../consumer";
import { prisma } from "../db";
import {
  createKafka,
  createProducer,
  createConsumer,
  startOutboxRelay,
  createRabbit,
} from "@ecom/shared";
import {
  makeEnvelope,
  CHARGE_PAYMENT,
  PAYMENT_SUCCEEDED,
  type EventEnvelope,
} from "@ecom/contracts";
import { signWebhookBody } from "./sign-webhook";

const PAYMENT_TOPIC = "payment.events";
const CHARGE_QUEUE = `payment.charge.e2e.wh.${Date.now()}`; // isolated queue per run

// Poll `pred` until it resolves truthy or `ms` elapses (checked every `step`).
async function waitFor(
  pred: () => Promise<boolean>,
  ms = 10000,
  step = 250
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, step));
  }
}

describe("payment async webhook e2e (needs docker compose up + migrated)", () => {
  const kafka = createKafka("payment-e2e-wh");
  const producer = createProducer(kafka);
  const consumer = createConsumer(kafka, `payment-e2e-wh-${Date.now()}`);
  let rabbit: Awaited<ReturnType<typeof createRabbit>>;
  let relay: { stop: () => void };
  const events: EventEnvelope[] = [];

  beforeAll(async () => {
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic: PAYMENT_TOPIC, numPartitions: 1, replicationFactor: 1 }],
    });
    await admin.disconnect();

    await producer.connect();
    relay = startOutboxRelay(outboxPort, producer, (t) => `${t}.events`, {
      intervalMs: 300,
    });
    await consumer.connect();
    await consumer.run([PAYMENT_TOPIC], async (env) => {
      events.push(env);
    });

    rabbit = await createRabbit();
    await rabbit.assertWorkQueue(CHARGE_QUEUE);
    await rabbit.consumeCommands(CHARGE_QUEUE, handleChargePayment, { maxRetries: 3 });
  });

  afterAll(async () => {
    relay.stop();
    await consumer.disconnect();
    await producer.disconnect();
    await rabbit.close();
    await prisma.$disconnect();
  });

  it("timeout leg: %100==99 -> PROCESSING (no event) -> webhook -> payment.succeeded", async () => {
    const orderId = `o_${randomUUID()}`;
    await rabbit.sendCommand(
      CHARGE_QUEUE,
      makeEnvelope({
        type: CHARGE_PAYMENT,
        version: 1,
        traceId: "t",
        producer: "order",
        payload: { orderId, amount: 599 },
      })
    );
    await waitFor(
      async () =>
        (await prisma.payment.findUnique({ where: { orderId } }))?.status === "PROCESSING"
    );
    expect((await prisma.payment.findUnique({ where: { orderId } }))?.status).toBe(
      "PROCESSING"
    );
    expect(
      await prisma.outbox.count({
        where: { aggregateId: orderId, type: PAYMENT_SUCCEEDED },
      })
    ).toBe(0);

    const webhookBody = { orderId, outcome: "SUCCEEDED" };
    await request(createApp({ rabbitHealth: async () => {} }))
      .post("/webhooks/payment")
      .set("x-webhook-signature", signWebhookBody(webhookBody))
      .send(webhookBody);

    await waitFor(
      async () =>
        (await prisma.outbox.count({
          where: { aggregateId: orderId, type: PAYMENT_SUCCEEDED },
        })) === 1
    );
    expect(
      await prisma.outbox.count({
        where: { aggregateId: orderId, type: PAYMENT_SUCCEEDED },
      })
    ).toBe(1);

    const evt = await (async () => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const hit = events.find(
          (e) =>
            e.type === PAYMENT_SUCCEEDED &&
            (e.payload as { orderId: string }).orderId === orderId
        );
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 400));
      }
      return undefined;
    })();
    expect(evt).toBeDefined();
  }, 30000);
});
