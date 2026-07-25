import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { scopedOutboxPort } from "./scoped-outbox";
import { prisma } from "../db";
import {
  createKafka,
  createProducer,
  createConsumer,
  startOutboxRelay,
} from "@ecom/shared";
import { ORDER_PLACED, type EventEnvelope } from "@ecom/contracts";

const ORDER_TOPIC = "order.events";
const app = createApp();
const ownOrders = new Set<string>();

describe("order slice e2e (needs docker compose up + migrated)", () => {
  const kafka = createKafka("order-e2e");
  const producer = createProducer(kafka);
  const orderConsumer = createConsumer(kafka, `order-e2e-${Date.now()}`);
  let relay: { stop: () => void };
  const placed: EventEnvelope[] = [];

  beforeAll(async () => {
    // Pre-create the topic before subscribing (avoids KafkaJS auto-create race).
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic: ORDER_TOPIC, numPartitions: 1, replicationFactor: 1 }],
    });
    await admin.disconnect();

    await producer.connect();
    relay = startOutboxRelay(
      scopedOutboxPort((id) => ownOrders.has(id)),
      producer,
      (t) => `${t}.events`,
      {
        intervalMs: 300,
      }
    );

    await orderConsumer.connect();
    await orderConsumer.run([ORDER_TOPIC], async (env) => {
      if (env.type === ORDER_PLACED) placed.push(env);
    });
  });

  afterAll(async () => {
    relay.stop();
    await orderConsumer.disconnect();
    await producer.disconnect();
    await prisma.$disconnect();
  });

  it("POST /orders -> OrderPlaced on order.events with matching items", async () => {
    const userId = `u_${randomUUID()}`;
    const pid = `p_${randomUUID()}`;
    await prisma.catalogReadModel.upsert({
      where: { productId: pid },
      create: { productId: pid, name: "x", price: 150, version: 1 },
      update: { name: "x", price: 150, version: 1 },
    });
    await request(app)
      .post("/cart/items")
      .set("x-user-id", userId)
      .send({ productId: pid, quantity: 4 });

    const res = await request(app).post("/orders").set("x-user-id", userId);
    ownOrders.add(res.body.orderId as string);
    expect(res.status).toBe(201);
    const orderId = res.body.orderId as string;

    const deadline = Date.now() + 25_000;
    while (
      !placed.some((e) => (e.payload as { orderId: string }).orderId === orderId) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 400));
    }

    const evt = placed.find(
      (e) => (e.payload as { orderId: string }).orderId === orderId
    );
    expect(evt).toBeDefined();
    expect((evt!.payload as { items: unknown[] }).items).toEqual([
      { productId: pid, quantity: 4 },
    ]);
  }, 30000);
});
