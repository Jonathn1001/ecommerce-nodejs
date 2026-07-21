import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { outboxPort } from "../outbox-adapter";
import { handleOrderEvent } from "../consumer";
import { prisma } from "../db";
import {
  createKafka,
  createProducer,
  createConsumer,
  startOutboxRelay,
  getRedis,
} from "@ecom/shared";
import {
  makeEnvelope,
  ORDER_PLACED,
  INVENTORY_RESERVED,
  type EventEnvelope,
} from "@ecom/contracts";

const ORDER_TOPIC = "order.events";
const INVENTORY_TOPIC = "inventory.events";

describe("inventory slice e2e (needs docker compose up + migrated)", () => {
  const kafka = createKafka("inventory-e2e");
  const producer = createProducer(kafka); // publishes OrderPlaced to order.events
  const orderConsumer = createConsumer(kafka, `inv-e2e-order-${Date.now()}`);
  const invConsumer = createConsumer(kafka, `inv-e2e-inv-${Date.now()}`);
  let relay: { stop: () => void };
  const reserved: EventEnvelope[] = [];

  beforeAll(async () => {
    // Pre-create both topics before subscribing (avoids KafkaJS's auto-create
    // race on fresh topics — see hello.e2e.test.ts for the same fix).
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [
        { topic: ORDER_TOPIC, numPartitions: 1, replicationFactor: 1 },
        { topic: INVENTORY_TOPIC, numPartitions: 1, replicationFactor: 1 },
      ],
    });
    await admin.disconnect();

    await producer.connect();
    relay = startOutboxRelay(
      outboxPort,
      producer,
      (aggregateType) => `${aggregateType}.events`,
      {
        intervalMs: 300,
      }
    );

    await orderConsumer.connect();
    await orderConsumer.run([ORDER_TOPIC], handleOrderEvent);

    await invConsumer.connect();
    await invConsumer.run([INVENTORY_TOPIC], async (env) => {
      if (env.type === INVENTORY_RESERVED) reserved.push(env);
    });
  });

  afterAll(async () => {
    relay.stop();
    await orderConsumer.disconnect();
    await invConsumer.disconnect();
    await producer.disconnect();
    (await getRedis()).quit();
    await prisma.$disconnect();
  });

  it("OrderPlaced on order.events -> InventoryReserved on inventory.events + stock decremented", async () => {
    const productId = `p_${randomUUID()}`;
    const orderId = `o_${randomUUID()}`;
    await prisma.inventory.create({ data: { productId, available: 10 } });

    await producer.publish(
      ORDER_TOPIC,
      makeEnvelope({
        type: ORDER_PLACED,
        version: 1,
        traceId: "e2e-1",
        producer: "test",
        payload: { orderId, items: [{ productId, quantity: 4 }] },
      })
    );

    const deadline = Date.now() + 25_000;
    while (
      !reserved.some((e) => (e.payload as { orderId: string }).orderId === orderId) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 400));
    }

    expect(
      reserved.some((e) => (e.payload as { orderId: string }).orderId === orderId)
    ).toBe(true);
    expect((await prisma.inventory.findUnique({ where: { productId } }))?.available).toBe(
      6
    );
  });
});
