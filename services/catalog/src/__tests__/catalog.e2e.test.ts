import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { outboxPort } from "../outbox-adapter";
import { prisma } from "../db";
import {
  createKafka,
  createProducer,
  createConsumer,
  startOutboxRelay,
} from "@ecom/shared";
import {
  CATALOG_PRODUCT_CREATED,
  CATALOG_PRODUCT_UPDATED,
  CATALOG_PRICE_CHANGED,
  type EventEnvelope,
} from "@ecom/contracts";

const CATALOG_TOPIC = "catalog.events";

describe("catalog slice e2e (needs docker compose up + migrated)", () => {
  const app = createApp();
  const kafka = createKafka("catalog-e2e");
  const producer = createProducer(kafka);
  const consumer = createConsumer(kafka, `catalog-e2e-${Date.now()}`);
  let relay: { stop: () => void };
  const events: EventEnvelope[] = [];

  beforeAll(async () => {
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic: CATALOG_TOPIC, numPartitions: 1, replicationFactor: 1 }],
    });
    await admin.disconnect();

    await producer.connect();
    // Catalog's outbox rows carry aggregateType "product" (not "catalog"), so the
    // topicFor mapping used by other services (`${aggregateType}.events`) doesn't
    // apply here -- pin every row to the single catalog.events topic instead.
    relay = startOutboxRelay(outboxPort, producer, () => CATALOG_TOPIC, {
      intervalMs: 300,
    });
    await consumer.connect();
    await consumer.run([CATALOG_TOPIC], async (env) => {
      events.push(env);
    });
  });

  afterAll(async () => {
    relay.stop();
    await consumer.disconnect();
    await producer.disconnect();
    await prisma.$disconnect();
  });

  async function waitFor(predicate: () => boolean, timeoutMs = 25_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  it("create + price update land on catalog.events (product_created, product_updated, price_changed)", async () => {
    const create = await request(app)
      .post("/products")
      .send({
        type: "ELECTRONICS",
        name: "E2E",
        price: 500,
        attributes: { manufacturer: "Acme" },
      });
    expect(create.status).toBe(201);
    const pid: string = create.body.productId;
    expect(pid).toBeTruthy();

    const patch = await request(app).patch(`/products/${pid}`).send({ price: 999 });
    expect(patch.status).toBe(200);

    // The relay/consumer are shared across the whole describe block and the
    // topic persists across runs (fromBeginning: true), so events seen for
    // OTHER productIds (this run's or a prior run's) must not count here.
    const seenTypesForThisProduct = () =>
      events
        .filter((e) => (e.payload as { productId?: string }).productId === pid)
        .map((e) => e.type);

    await waitFor(() => seenTypesForThisProduct().length >= 3);

    const seen = seenTypesForThisProduct();
    expect(seen).toContain(CATALOG_PRODUCT_CREATED);
    expect(seen).toContain(CATALOG_PRODUCT_UPDATED);
    expect(seen).toContain(CATALOG_PRICE_CHANGED);
  }, 30000);
});
