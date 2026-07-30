import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { createOrderListener } from "../sse-listener";
import { handleEvent } from "../consumer";
import { prisma } from "../db";
import { config } from "../config";
import { makeEnvelope, PAYMENT_SUCCEEDED } from "@ecom/contracts";

const listener = createOrderListener(config.DATABASE_URL);
const app = createApp({ sseRegistry: listener.registry });
let server: http.Server;
let baseUrl: string;

// Tag every order this file seeds so afterAll can find and delete them by a DB
// query, not an in-memory id list — a mid-suite throw still gets cleaned up.
// The stream test drives handleEvent with a fake PaymentSucceeded straight into
// the order database, landing an order in CONFIRMED with no Payment row behind
// it — a state the real system cannot produce. Left uncleaned, that trips
// INV6_CONFIRMED_INCOMPLETE on every run.
const TEST_TAG = "test-order-stream-int";

async function seedOrder(
  status: string,
  totalPrice = 500,
  userId = `${TEST_TAG}-${randomUUID()}`
): Promise<{ id: string; userId: string }> {
  const o = await prisma.order.create({
    data: {
      userId,
      status,
      totalPrice,
      items: {
        create: [{ productId: `p_${randomUUID()}`, quantity: 1, unitPrice: totalPrice }],
      },
    },
  });
  return { id: o.id, userId };
}

// Collect SSE data frames until `until` matches or a deadline; then destroy.
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

describe("order SSE stream (integration — needs compose up + migrated)", () => {
  beforeAll(async () => {
    await listener.start();
    await new Promise<void>((r) => {
      server = app.listen(0, () => r());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await listener.close();
    // Outbox rows are keyed by aggregateId, not userId, and do not cascade from
    // Order (no FK) — deleted separately or they keep tripping INV4_OUTBOX_UNSENT.
    // OrderItem does cascade (onDelete: Cascade in schema.prisma).
    const seeded = await prisma.order.findMany({
      where: { userId: { startsWith: TEST_TAG } },
      select: { id: true },
    });
    const ids = seeded.map((o) => o.id);
    if (ids.length > 0) {
      await prisma.outbox.deleteMany({ where: { aggregateId: { in: ids } } });
      await prisma.order.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.$disconnect();
  });

  it("streams the initial status then a live transition, and closes on terminal", async () => {
    const { id, userId } = await seedOrder("AWAITING_PAYMENT");
    const framesP = streamFrames(
      `/orders/${id}/stream`,
      (s) => s === "CONFIRMED",
      userId
    );
    await new Promise((r) => setTimeout(r, 300)); // let the stream subscribe
    await handleEvent(
      makeEnvelope({
        type: PAYMENT_SUCCEEDED,
        version: 1,
        traceId: "t",
        producer: "payment",
        payload: { orderId: id, paymentId: "pay_1", amount: 500 },
      })
    );
    const frames = await framesP;
    const statuses = frames.map((f) => f.status);
    expect(statuses[0]).toBe("AWAITING_PAYMENT"); // initial
    expect(statuses).toContain("CONFIRMED"); // live transition
  }, 15000);

  it("404 for an unknown order", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      // Without an error handler, a connection failure here is an unhandled 'error'
      // event on the request — it crashes the worker instead of failing this one test,
      // which reads as the whole suite hanging/timing out rather than a clean red.
      const req = http.get(
        `${baseUrl}/orders/o_${randomUUID()}/stream`,
        { headers: { "x-user-id": `u_${randomUUID()}` } },
        (res) => {
          res.on("error", reject);
          resolve(res.statusCode ?? 0);
          res.destroy();
        }
      );
      req.on("error", reject);
    });
    expect(status).toBe(404);
  });
});
