import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { prisma } from "../db";
import { PAYMENT_SUCCEEDED, PAYMENT_FAILED } from "@ecom/contracts";

const app = createApp({ rabbitHealth: async () => {} });
const seedProcessing = async (amount = 599): Promise<string> => {
  const orderId = `o_${randomUUID()}`;
  await prisma.payment.create({ data: { orderId, amount, status: "PROCESSING" } });
  return orderId;
};
const outbox = (orderId: string, type: string) =>
  prisma.outbox.count({ where: { aggregateId: orderId, type } });
const statusOf = async (orderId: string) =>
  (await prisma.payment.findUnique({ where: { orderId } }))?.status;

describe("payment webhook (integration — needs compose up + migrated)", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("SUCCEEDED webhook finalizes a PROCESSING payment + emits payment.succeeded", async () => {
    const orderId = await seedProcessing();
    const res = await request(app).post("/webhooks/payment").send({ orderId, outcome: "SUCCEEDED" });
    expect(res.status).toBe(200);
    expect(await statusOf(orderId)).toBe("SUCCEEDED");
    expect(await outbox(orderId, PAYMENT_SUCCEEDED)).toBe(1);
  });

  it("FAILED webhook emits payment.failed", async () => {
    const orderId = await seedProcessing();
    await request(app).post("/webhooks/payment").send({ orderId, outcome: "FAILED" });
    expect(await statusOf(orderId)).toBe("FAILED");
    expect(await outbox(orderId, PAYMENT_FAILED)).toBe(1);
  });

  it("redelivered webhook is an idempotent no-op (one event)", async () => {
    const orderId = await seedProcessing();
    await request(app).post("/webhooks/payment").send({ orderId, outcome: "SUCCEEDED" });
    const res2 = await request(app).post("/webhooks/payment").send({ orderId, outcome: "SUCCEEDED" });
    expect(res2.status).toBe(200);
    expect(await outbox(orderId, PAYMENT_SUCCEEDED)).toBe(1);
  });

  it("unknown order -> 404; malformed body -> 400", async () => {
    const r404 = await request(app).post("/webhooks/payment").send({ orderId: `o_${randomUUID()}`, outcome: "SUCCEEDED" });
    expect(r404.status).toBe(404);
    const r400 = await request(app).post("/webhooks/payment").send({ orderId: "o1" });
    expect(r400.status).toBe(400);
  });
});
