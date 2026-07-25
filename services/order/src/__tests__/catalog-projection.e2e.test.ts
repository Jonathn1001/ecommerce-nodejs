import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { handleCatalogEvent } from "../catalog-projection";
import { prisma } from "../db";
import { createKafka, createProducer, createConsumer } from "@ecom/shared";
import {
  makeEnvelope,
  CATALOG_PRODUCT_CREATED,
  CATALOG_PRODUCT_UPDATED,
} from "@ecom/contracts";

const CATALOG_TOPIC = "catalog.events";
const app = createApp();

describe("cross-service catalog projection e2e (needs compose up + migrated)", () => {
  const kafka = createKafka("order-catalog-projection-e2e");
  const producer = createProducer(kafka);
  // Own consumer group, independent of the production "order-catalog-projection"
  // group and of the saga consumer's group — mirrors main.ts's wiring exactly,
  // just pointed at Order's real handleCatalogEvent.
  const consumer = createConsumer(kafka, `order-catalog-projection-e2e-${Date.now()}`);

  beforeAll(async () => {
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic: CATALOG_TOPIC, numPartitions: 1, replicationFactor: 1 }],
    });
    await admin.disconnect();
    await producer.connect();
    await consumer.connect();
    await consumer.run([CATALOG_TOPIC], handleCatalogEvent);
  });

  afterAll(async () => {
    await consumer.disconnect();
    await producer.disconnect();
    await prisma.$disconnect();
  });

  async function waitFor(
    predicate: () => Promise<boolean> | boolean,
    timeoutMs = 25_000
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  // Adds pid to a fresh user's cart and places the order; returns the orderId.
  async function placeForProduct(
    pid: string,
    quantity: number
  ): Promise<{ orderId: string; userId: string }> {
    const userId = `u_${randomUUID()}`;
    await request(app)
      .post("/cart/items")
      .set("x-user-id", userId)
      .send({ productId: pid, quantity });
    const res = await request(app).post("/orders").set("x-user-id", userId);
    return { orderId: res.body.orderId as string, userId };
  }

  it("projected product prices a real order (no admin seed)", async () => {
    const pid = `p_${randomUUID()}`;
    await producer.publish(
      CATALOG_TOPIC,
      makeEnvelope({
        type: CATALOG_PRODUCT_CREATED,
        version: 1,
        traceId: "t",
        producer: "catalog",
        payload: { productId: pid, name: "Widget", price: 750, version: 1 },
      })
    );
    await waitFor(
      async () =>
        (await prisma.catalogReadModel.findUnique({ where: { productId: pid } }))
          ?.price === 750
    );

    // place() adds pid to cart + posts /orders; the order totals from the projected price
    const { orderId, userId } = await placeForProduct(pid, 1);
    const order = (await request(app).get(`/orders/${orderId}`).set("x-user-id", userId))
      .body;
    expect(order.totalPrice).toBe(750);
  }, 30000);

  it("a later product_updated re-projects; the next order prices from the new value", async () => {
    const pid = `p_${randomUUID()}`;
    await producer.publish(
      CATALOG_TOPIC,
      makeEnvelope({
        type: CATALOG_PRODUCT_CREATED,
        version: 1,
        traceId: "t",
        producer: "catalog",
        payload: { productId: pid, name: "Widget", price: 500, version: 1 },
      })
    );
    await waitFor(
      async () =>
        (await prisma.catalogReadModel.findUnique({ where: { productId: pid } }))
          ?.price === 500
    );

    await producer.publish(
      CATALOG_TOPIC,
      makeEnvelope({
        type: CATALOG_PRODUCT_UPDATED,
        version: 1,
        traceId: "t",
        producer: "catalog",
        payload: { productId: pid, name: "Widget", price: 900, version: 2 },
      })
    );
    await waitFor(
      async () =>
        (await prisma.catalogReadModel.findUnique({ where: { productId: pid } }))
          ?.price === 900
    );

    const { orderId, userId } = await placeForProduct(pid, 1);
    const order = (await request(app).get(`/orders/${orderId}`).set("x-user-id", userId))
      .body;
    expect(order.totalPrice).toBe(900);
  }, 30000);
});
