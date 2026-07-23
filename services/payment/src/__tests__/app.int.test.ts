import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { handleChargePayment } from "../consumer";
import { prisma } from "../db";
import { makeEnvelope, CHARGE_PAYMENT } from "@ecom/contracts";

const app = createApp({ rabbitHealth: async () => {} }); // rabbit health stubbed for the app test

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
    await handleChargePayment(
      makeEnvelope({ type: CHARGE_PAYMENT, version: 1, traceId: "t", producer: "test", payload: { orderId, amount: 700 } })
    );
    const got = await request(app).get(`/payments/${orderId}`);
    expect(got.status).toBe(200);
    expect(got.body.status).toBe("SUCCEEDED");
    expect(got.body.amount).toBe(700);

    const missing = await request(app).get(`/payments/o_${randomUUID()}`);
    expect(missing.status).toBe(404);
  });
});
