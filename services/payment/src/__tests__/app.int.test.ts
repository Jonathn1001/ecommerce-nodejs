import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { handleChargePayment } from "../consumer";
import { prisma } from "../db";
import { makeEnvelope, CHARGE_PAYMENT } from "@ecom/contracts";

const app = createApp({ rabbitHealth: async () => {} }); // rabbit health stubbed for the app test

// Tag every orderId this file invents so afterAll can find and delete the rows by a DB
// query, not an in-memory id list — a mid-suite throw still gets cleaned up. The one
// test that charges for real enqueues an outbox row keyed by orderId, and no relay runs
// during an integration test, so it sits unsent and INV4_OUTBOX_UNSENT reports it.
const TEST_TAG = "test-payment-app-int";
const taggedOrder = () => `${TEST_TAG}-o-${randomUUID()}`;

const seedProcessingPayment = async (orderId: string, amount = 599): Promise<void> => {
  await prisma.payment.create({ data: { orderId, amount, status: "PROCESSING" } });
};

describe("payment app (integration — needs docker compose up + migrated)", () => {
  afterAll(async () => {
    // PaymentAttempt cascades from Payment (onDelete: Cascade in schema.prisma);
    // Outbox has no FK to it, so it is deleted explicitly.
    await prisma.outbox.deleteMany({ where: { aggregateId: { startsWith: TEST_TAG } } });
    await prisma.payment.deleteMany({ where: { orderId: { startsWith: TEST_TAG } } });
    await prisma.$disconnect();
  });

  it("GET /readyz is 200 when the checks pass", async () => {
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(200);
  });

  it("GET /payments/:orderId returns the payment after a charge; 404 when unknown", async () => {
    const orderId = taggedOrder();
    const userId = `u_${randomUUID()}`;
    await handleChargePayment(
      makeEnvelope({
        type: CHARGE_PAYMENT,
        version: 1,
        traceId: "t",
        producer: "test",
        payload: { orderId, userId, amount: 700 },
      })
    );
    const got = await request(app).get(`/payments/${orderId}`).set("x-user-id", userId);
    expect(got.status).toBe(200);
    expect(got.body.status).toBe("SUCCEEDED");
    expect(got.body.amount).toBe(700);

    const missing = await request(app)
      .get(`/payments/${taggedOrder()}`)
      .set("x-user-id", userId);
    expect(missing.status).toBe(404);
  });

  it("GET /payments/:orderId is 400 without x-user-id", async () => {
    const orderId = taggedOrder();
    const res = await request(app).get(`/payments/${orderId}`);
    expect(res.status).toBe(400);
  });

  it("the owner reads their payment; another user and a legacy row both 404", async () => {
    const orderId = taggedOrder();
    const userId = `u_${randomUUID()}`;
    await prisma.payment.create({
      data: { orderId, userId, amount: 100, status: "SUCCEEDED" },
    });
    await request(app).get(`/payments/${orderId}`).set("x-user-id", userId).expect(200);
    await request(app)
      .get(`/payments/${orderId}`)
      .set("x-user-id", "someone-else")
      .expect(404);

    const legacy = taggedOrder();
    await prisma.payment.create({
      data: { orderId: legacy, amount: 100, status: "SUCCEEDED" },
    });
    await request(app).get(`/payments/${legacy}`).set("x-user-id", userId).expect(404);
  });

  it("rejects an unsigned webhook with 401 and touches no payment", async () => {
    const orderId = taggedOrder();
    await seedProcessingPayment(orderId);
    await request(app)
      .post("/webhooks/payment")
      .send({ orderId, outcome: "SUCCEEDED" })
      .expect(401);
    expect((await prisma.payment.findUnique({ where: { orderId } }))?.status).toBe(
      "PROCESSING"
    );
  });
});
