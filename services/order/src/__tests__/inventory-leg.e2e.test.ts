import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { handleEvent } from "../consumer";
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

async function placeOrder(): Promise<{ orderId: string; userId: string }> {
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
    .send({ productId: pid, quantity: 2 });
  const res = await request(app).post("/orders").set("x-user-id", userId);
  return { orderId: res.body.orderId as string, userId };
}
async function waitForStatus(
  orderId: string,
  want: string,
  userId: string
): Promise<string> {
  const deadline = Date.now() + 25_000;
  const read = () => request(app).get(`/orders/${orderId}`).set("x-user-id", userId);
  while (Date.now() < deadline) {
    const got = await read();
    if (got.body.status === want) return got.body.status;
    await new Promise((r) => setTimeout(r, 400));
  }
  return (await read()).body.status;
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
    await consumer.run([INVENTORY_TOPIC], handleEvent);
  });

  afterAll(async () => {
    await consumer.disconnect();
    await producer.disconnect();
    await prisma.$disconnect();
  });

  it("InventoryReserved on the wire drives PENDING -> AWAITING_PAYMENT", async () => {
    const { orderId, userId } = await placeOrder();
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
    expect(await waitForStatus(orderId, "AWAITING_PAYMENT", userId)).toBe(
      "AWAITING_PAYMENT"
    );
  }, 30000);

  it("InventoryReservationFailed drives -> CANCELLED and emits OrderCancelled", async () => {
    const { orderId, userId } = await placeOrder();
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
    expect(await waitForStatus(orderId, "CANCELLED", userId)).toBe("CANCELLED");
    expect(
      await prisma.outbox.count({
        where: { aggregateId: orderId, type: ORDER_CANCELLED },
      })
    ).toBe(1);
  }, 30000);
});
