import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { createOrderListener } from "../sse-listener";
import { scopedOutboxPort } from "./scoped-outbox";
import { handleEvent } from "../consumer";
import { prisma } from "../db";
import { config } from "../config";
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
  CHARGE_PAYMENT,
  type EventEnvelope,
} from "@ecom/contracts";

const CHARGE_QUEUE = `payment.charge.e2e.sse.${Date.now()}`;
const ownOrders = new Set<string>();

const listener = createOrderListener(config.DATABASE_URL);
const app = createApp({ sseRegistry: listener.registry });
let server: http.Server;
let baseUrl: string;

// Collect SSE data frames until `until` matches or a deadline; then destroy.
// Copied verbatim from order-stream.int.test.ts (Task 7).
function streamFrames(
  path: string,
  until: (s: string) => boolean,
  userId: string,
  ms = 8000
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    // The gateway injects this header in production; here the test plays that role.
    const req = http.get(
      `${baseUrl}${path}`,
      { headers: { "x-user-id": userId } },
      (res) => {
        const frames: any[] = [];
        let buf = "";
        const timer = setTimeout(() => {
          req.destroy();
          resolve(frames);
        }, ms);
        res.on("data", (chunk) => {
          buf += chunk.toString();
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = block.split("\n").find((l) => l.startsWith("data: "));
            if (line) {
              const frame = JSON.parse(line.slice(6));
              frames.push(frame);
              if (until(frame.status)) {
                clearTimeout(timer);
                req.destroy();
                resolve(frames);
              }
            }
          }
        });
        res.on("error", () => {});
      }
    );
    req.on("error", reject);
  });
}

describe("order SSE stream e2e (needs compose up + migrated)", () => {
  const kafka = createKafka("order-e2e-sse");
  const producer = createProducer(kafka);
  const consumer = createConsumer(kafka, `order-e2e-sse-${Date.now()}`);
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
      scopedOutboxPort((id) => ownOrders.has(id)),
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

    await listener.start();
    await new Promise<void>((r) => {
      server = app.listen(0, () => r());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => {
    relay.stop();
    await consumer.disconnect();
    await rabbit.close();
    await producer.disconnect();
    await new Promise<void>((r) => server.close(() => r()));
    await listener.close();
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
  const reserved = (id: string): EventEnvelope =>
    makeEnvelope({
      type: INVENTORY_RESERVED,
      version: 1,
      traceId: "t",
      producer: "inventory",
      payload: { orderId: id, items: [{ productId: "p1", quantity: 1 }] },
    });

  it("streams PENDING/AWAITING_PAYMENT -> CONFIRMED for a real placed order", async () => {
    const { orderId: id, userId } = await place(500);
    const framesP = streamFrames(
      `/orders/${id}/stream`,
      (s) => s === "CONFIRMED",
      userId,
      25000
    );
    await new Promise((r) => setTimeout(r, 300));
    await producer.publish("inventory.events", reserved(id));
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
    const statuses = (await framesP).map((f) => f.status);
    expect(statuses).toContain("AWAITING_PAYMENT");
    expect(statuses).toContain("CONFIRMED");
  }, 40000);
});
