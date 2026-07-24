import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { outboxPort } from "../outbox-adapter";
import { handleEvent } from "../consumer";
import { prisma } from "../db";
import { createKafka, createProducer, createConsumer, startOutboxRelay, createRabbit } from "@ecom/shared";
import {
  makeEnvelope, INVENTORY_RESERVED, PAYMENT_SUCCEEDED, PAYMENT_FAILED,
  CHARGE_PAYMENT, type EventEnvelope,
} from "@ecom/contracts";

const CHARGE_QUEUE = `payment.charge.e2e.${Date.now()}`;
const app = createApp();

describe("order payment-leg e2e (needs compose up + migrated)", () => {
  const kafka = createKafka("order-e2e-3b");
  const producer = createProducer(kafka);
  const consumer = createConsumer(kafka, `order-e2e-3b-${Date.now()}`);
  let rabbit: Awaited<ReturnType<typeof createRabbit>>;
  let relay: { stop: () => void };

  beforeAll(async () => {
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [
        { topic: "inventory.events", numPartitions: 1, replicationFactor: 1 },
        { topic: "payment.events", numPartitions: 1, replicationFactor: 1 },
      ],
    });
    await admin.disconnect();
    await producer.connect();
    rabbit = await createRabbit();
    await rabbit.assertWorkQueue(CHARGE_QUEUE);
    // relay routes Order's ChargePayment rows to the isolated e2e queue
    relay = startOutboxRelay(outboxPort, producer, (t) => `${t}.events`, {
      intervalMs: 300,
      commands: { sender: rabbit, queueFor: (r) => (r.type === CHARGE_PAYMENT ? CHARGE_QUEUE : null) },
    });
    await consumer.connect();
    await consumer.run(["inventory.events", "payment.events"], handleEvent);
  });
  afterAll(async () => {
    relay.stop();
    await consumer.disconnect();
    await rabbit.close();
    await producer.disconnect();
    await prisma.$disconnect();
  });

  async function place(total: number): Promise<string> {
    const userId = `u_${randomUUID()}`;
    const pid = `p_${randomUUID()}`;
    await request(app).post("/admin/catalog").send({ productId: pid, name: "x", price: total });
    await request(app).post("/cart/items").set("x-user-id", userId).send({ productId: pid, quantity: 1 });
    const res = await request(app).post("/orders").set("x-user-id", userId);
    return res.body.orderId as string;
  }
  async function waitStatus(id: string, want: string): Promise<string> {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const s = (await request(app).get(`/orders/${id}`)).body.status;
      if (s === want) return s;
      await new Promise((r) => setTimeout(r, 400));
    }
    return (await request(app).get(`/orders/${id}`)).body.status;
  }
  const reserved = (id: string): EventEnvelope =>
    makeEnvelope({ type: INVENTORY_RESERVED, version: 1, traceId: "t", producer: "inventory",
      payload: { orderId: id, items: [{ productId: "p1", quantity: 1 }] } });

  it("confirm leg: reserved -> ChargePayment enqueued -> PaymentSucceeded -> CONFIRMED", async () => {
    const id = await place(500);
    await producer.publish("inventory.events", reserved(id));
    expect(await waitStatus(id, "AWAITING_PAYMENT")).toBe("AWAITING_PAYMENT");
    // the ChargePayment was routed to the isolated queue (real Rabbit round-trip)
    const cmd = await rabbit.consumeDlqOnce(CHARGE_QUEUE, 10_000);
    expect(cmd?.type).toBe(CHARGE_PAYMENT);
    // inject the payment result Payment would emit
    await producer.publish("payment.events",
      makeEnvelope({ type: PAYMENT_SUCCEEDED, version: 1, traceId: "t", producer: "payment",
        payload: { orderId: id, paymentId: "pay_1", amount: 500 } }));
    expect(await waitStatus(id, "CONFIRMED")).toBe("CONFIRMED");
  }, 30000);

  it("compensation leg: reserved -> PaymentFailed -> CANCELLED", async () => {
    const id = await place(600);
    await producer.publish("inventory.events", reserved(id));
    expect(await waitStatus(id, "AWAITING_PAYMENT")).toBe("AWAITING_PAYMENT");
    await producer.publish("payment.events",
      makeEnvelope({ type: PAYMENT_FAILED, version: 1, traceId: "t", producer: "payment",
        payload: { orderId: id, reason: "CARD_DECLINED" } }));
    expect(await waitStatus(id, "CANCELLED")).toBe("CANCELLED");
  }, 30000);
});
