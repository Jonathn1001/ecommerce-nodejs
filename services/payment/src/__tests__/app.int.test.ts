import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { handleChargePayment } from "../consumer";
import { prisma } from "../db";
import { makeEnvelope, CHARGE_PAYMENT } from "@ecom/contracts";

const app = createApp({ rabbitHealth: async () => {} }); // rabbit health stubbed for the app test

const seedProcessingPayment = async (orderId: string, amount = 599): Promise<void> => {
  await prisma.payment.create({ data: { orderId, amount, status: "PROCESSING" } });
};

describe("payment app (integration — needs docker compose up + migrated)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("GET /readyz is 200 when the checks pass", async () => {
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(200);
  });

  it("GET /payments/:orderId returns the payment after a charge; 404 when unknown", async () => {
    const orderId = `o_${randomUUID()}`;
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
      .get(`/payments/o_${randomUUID()}`)
      .set("x-user-id", userId);
    expect(missing.status).toBe(404);
  });

  it("GET /payments/:orderId is 400 without x-user-id", async () => {
    const orderId = `o_${randomUUID()}`;
    const res = await request(app).get(`/payments/${orderId}`);
    expect(res.status).toBe(400);
  });

  it("the owner reads their payment; another user and a legacy row both 404", async () => {
    const orderId = `o_${randomUUID()}`;
    const userId = `u_${randomUUID()}`;
    await prisma.payment.create({
      data: { orderId, userId, amount: 100, status: "SUCCEEDED" },
    });
    await request(app).get(`/payments/${orderId}`).set("x-user-id", userId).expect(200);
    await request(app)
      .get(`/payments/${orderId}`)
      .set("x-user-id", "someone-else")
      .expect(404);

    const legacy = `o_${randomUUID()}`;
    await prisma.payment.create({
      data: { orderId: legacy, amount: 100, status: "SUCCEEDED" },
    });
    await request(app).get(`/payments/${legacy}`).set("x-user-id", userId).expect(404);
  });

  it("rejects an unsigned webhook with 401 and touches no payment", async () => {
    const orderId = `o_${randomUUID()}`;
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
