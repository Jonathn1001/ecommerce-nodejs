import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { handleInventoryEvent } from "../consumer";
import { prisma } from "../db";
import { createKafka, createProducer, createConsumer } from "@ecom/shared";
import {
  makeEnvelope,
  INVENTORY_RESERVED,
  INVENTORY_RESERVATION_FAILED,
  ORDER_CANCELLED,
} from "@ecom/contracts";

const INVENTORY_TOPIC = "inventory.events";
const app = createApp();

async function placeOrder(): Promise<string> {
  const userId = `u_${randomUUID()}`;
  const pid = `p_${randomUUID()}`;
  await request(app)
    .post("/admin/catalog")
    .send({ productId: pid, name: "x", price: 150 });
  await request(app)
    .post("/cart/items")
    .set("x-user-id", userId)
    .send({ productId: pid, quantity: 2 });
  const res = await request(app).post("/orders").set("x-user-id", userId);
  return res.body.orderId as string;
}
async function waitForStatus(orderId: string, want: string): Promise<string> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const got = await request(app).get(`/orders/${orderId}`);
    if (got.body.status === want) return got.body.status;
    await new Promise((r) => setTimeout(r, 400));
  }
  return (await request(app).get(`/orders/${orderId}`)).body.status;
}

describe("order inventory-leg slice e2e (needs docker compose up + migrated)", () => {
  const kafka = createKafka("order-e2e-2b");
  const producer = createProducer(kafka);
  const consumer = createConsumer(kafka, `order-e2e-2b-${Date.now()}`);

  beforeAll(async () => {
    // Pre-create the topic before subscribing (avoids KafkaJS auto-create race).
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic: INVENTORY_TOPIC, numPartitions: 1, replicationFactor: 1 }],
    });
    await admin.disconnect();

    await producer.connect();
    await consumer.connect();
    await consumer.run([INVENTORY_TOPIC], handleInventoryEvent);
  });

  afterAll(async () => {
    await consumer.disconnect();
    await producer.disconnect();
    await prisma.$disconnect();
  });

  it("InventoryReserved on the wire drives PENDING -> AWAITING_PAYMENT", async () => {
    const orderId = await placeOrder();
    await producer.publish(
      INVENTORY_TOPIC,
      makeEnvelope({
        type: INVENTORY_RESERVED,
        version: 1,
        traceId: "t",
        producer: "inventory",
        payload: { orderId, items: [{ productId: "p1", quantity: 2 }] },
      })
    );
    expect(await waitForStatus(orderId, "AWAITING_PAYMENT")).toBe("AWAITING_PAYMENT");
  }, 30000);

  it("InventoryReservationFailed drives -> CANCELLED and emits OrderCancelled", async () => {
    const orderId = await placeOrder();
    await producer.publish(
      INVENTORY_TOPIC,
      makeEnvelope({
        type: INVENTORY_RESERVATION_FAILED,
        version: 1,
        traceId: "t",
        producer: "inventory",
        payload: { orderId, reason: "INSUFFICIENT_STOCK" },
      })
    );
    expect(await waitForStatus(orderId, "CANCELLED")).toBe("CANCELLED");
    expect(
      await prisma.outbox.count({
        where: { aggregateId: orderId, type: ORDER_CANCELLED },
      })
    ).toBe(1);
  }, 30000);
});
