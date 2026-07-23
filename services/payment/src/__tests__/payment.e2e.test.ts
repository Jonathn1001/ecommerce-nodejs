import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
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
  PAYMENT_FAILED,
  type EventEnvelope,
} from "@ecom/contracts";

const PAYMENT_TOPIC = "payment.events";
const CHARGE_QUEUE = `payment.charge.e2e.${Date.now()}`; // isolated queue per run

describe("payment slice e2e (needs docker compose up + migrated)", () => {
  const kafka = createKafka("payment-e2e");
  const producer = createProducer(kafka);
  const consumer = createConsumer(kafka, `payment-e2e-${Date.now()}`);
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

  async function waitFor(
    orderId: string,
    type: string
  ): Promise<EventEnvelope | undefined> {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const hit = events.find(
        (e) => e.type === type && (e.payload as { orderId: string }).orderId === orderId
      );
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 400));
    }
    return events.find(
      (e) => e.type === type && (e.payload as { orderId: string }).orderId === orderId
    );
  }

  it("ChargePayment (success amount) -> PaymentSucceeded on payment.events", async () => {
    const orderId = `o_${randomUUID()}`;
    await rabbit.sendCommand(
      CHARGE_QUEUE,
      makeEnvelope({
        type: CHARGE_PAYMENT,
        version: 1,
        traceId: "t",
        producer: "test",
        payload: { orderId, amount: 500 },
      })
    );
    const evt = await waitFor(orderId, PAYMENT_SUCCEEDED);
    expect(evt).toBeDefined();
    expect((evt!.payload as { amount: number }).amount).toBe(500);
  }, 30000);

  it("ChargePayment (...01 amount) -> PaymentFailed on payment.events", async () => {
    const orderId = `o_${randomUUID()}`;
    await rabbit.sendCommand(
      CHARGE_QUEUE,
      makeEnvelope({
        type: CHARGE_PAYMENT,
        version: 1,
        traceId: "t",
        producer: "test",
        payload: { orderId, amount: 101 },
      })
    );
    const evt = await waitFor(orderId, PAYMENT_FAILED);
    expect(evt).toBeDefined();
    expect((evt!.payload as { reason: string }).reason).toBe("CARD_DECLINED");
  }, 30000);

  it("a malformed-payload command (valid envelope) lands in the queue DLQ after retries", async () => {
    await rabbit.sendCommand(
      CHARGE_QUEUE,
      makeEnvelope({
        type: CHARGE_PAYMENT,
        version: 1,
        traceId: "t",
        producer: "test",
        payload: { orderId: "o_bad" },
      }) // amount missing -> handler parse throws
    );
    const dlq = await rabbit.consumeDlqOnce(`${CHARGE_QUEUE}.dlq`, 15_000);
    expect(dlq?.type).toBe(CHARGE_PAYMENT);
  }, 30000);
});
