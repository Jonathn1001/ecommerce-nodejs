import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { scopedOutboxPort } from "./scoped-outbox";
import { handleEvent } from "../consumer";
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
  INVENTORY_RESERVED,
  PAYMENT_SUCCEEDED,
  PAYMENT_FAILED,
  CHARGE_PAYMENT,
  type EventEnvelope,
  type ChargePaymentPayload,
} from "@ecom/contracts";

const CHARGE_QUEUE = `payment.charge.e2e.${Date.now()}`;
const ownOrders = new Set<string>();
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
    relay = startOutboxRelay(
      scopedOutboxPort(() => [...ownOrders]),
      producer,
      (t) => `${t}.events`,
      {
        intervalMs: 300,
        commands: {
          sender: rabbit,
          // Scoped to THIS suite's orders: a bare type filter also grabs the sibling e2e
          // file's ChargePayment rows when vitest runs them in parallel, and whichever relay
          // polls first wins — the other test then waits forever for a command that was
          // delivered to someone else's queue.
          queueFor: (r) =>
            r.type === CHARGE_PAYMENT && ownOrders.has(r.aggregateId)
              ? CHARGE_QUEUE
              : null,
        },
      }
    );
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

  async function place(total: number): Promise<{ orderId: string; userId: string }> {
    const userId = `u_${randomUUID()}`;
    const pid = `p_${randomUUID()}`;
    await prisma.catalogReadModel.upsert({
      where: { productId: pid },
      create: { productId: pid, name: "x", price: total, version: 1 },
      update: { name: "x", price: total, version: 1 },
    });
    await request(app)
      .post("/cart/items")
      .set("x-user-id", userId)
      .send({ productId: pid, quantity: 1 });
    const res = await request(app).post("/orders").set("x-user-id", userId);
    ownOrders.add(res.body.orderId as string);
    return { orderId: res.body.orderId as string, userId };
  }
  async function waitStatus(id: string, want: string, userId: string): Promise<string> {
    const deadline = Date.now() + 25_000;
    const read = async () =>
      (await request(app).get(`/orders/${id}`).set("x-user-id", userId)).body.status;
    while (Date.now() < deadline) {
      const s = await read();
      if (s === want) return s;
      await new Promise((r) => setTimeout(r, 400));
    }
    return read();
  }
  const reserved = (id: string): EventEnvelope =>
    makeEnvelope({
      type: INVENTORY_RESERVED,
      version: 1,
      traceId: "t",
      producer: "inventory",
      payload: { orderId: id, items: [{ productId: "p1", quantity: 1 }] },
    });

  it("confirm leg: reserved -> ChargePayment enqueued -> PaymentSucceeded -> CONFIRMED", async () => {
    const { orderId: id, userId } = await place(500);
    await producer.publish("inventory.events", reserved(id));
    expect(await waitStatus(id, "AWAITING_PAYMENT", userId)).toBe("AWAITING_PAYMENT");
    // the ChargePayment was routed to the isolated queue (real Rabbit round-trip)
    const cmd = await rabbit.consumeDlqOnce(CHARGE_QUEUE, 10_000);
    expect(cmd?.type).toBe(CHARGE_PAYMENT);
    expect((cmd?.payload as ChargePaymentPayload).orderId).toBe(id);
    // inject the payment result Payment would emit
    await producer.publish(
      "payment.events",
      makeEnvelope({
        type: PAYMENT_SUCCEEDED,
        version: 1,
        traceId: "t",
        producer: "payment",
        payload: { orderId: id, paymentId: "pay_1", amount: 500 },
      })
    );
    expect(await waitStatus(id, "CONFIRMED", userId)).toBe("CONFIRMED");
  }, 30000);

  it("compensation leg: reserved -> PaymentFailed -> CANCELLED", async () => {
    const { orderId: id, userId } = await place(600);
    await producer.publish("inventory.events", reserved(id));
    expect(await waitStatus(id, "AWAITING_PAYMENT", userId)).toBe("AWAITING_PAYMENT");
    await producer.publish(
      "payment.events",
      makeEnvelope({
        type: PAYMENT_FAILED,
        version: 1,
        traceId: "t",
        producer: "payment",
        payload: { orderId: id, reason: "CARD_DECLINED" },
      })
    );
    expect(await waitStatus(id, "CANCELLED", userId)).toBe("CANCELLED");
  }, 30000);
});
