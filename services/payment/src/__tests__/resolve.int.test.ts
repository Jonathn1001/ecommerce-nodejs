import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { prisma } from "../db";
import { PAYMENT_SUCCEEDED, PAYMENT_FAILED, PAYMENT_REFUNDED } from "@ecom/contracts";
import { signWebhookBody } from "./sign-webhook";

const app = createApp({ rabbitHealth: async () => {} });

// Tag every orderId this file invents so the cleanup can find and delete the rows by a
// DB query, not an in-memory id list — a mid-suite throw still gets cleaned up.
// Resolving a webhook or a refund enqueues an outbox row keyed by orderId, and no relay
// runs during an integration test, so it sits unsent and INV4_OUTBOX_UNSENT reports it.
// The cleanup is registered at file level, not inside a describe: there are two describe
// blocks here and only the first has an afterAll, so a describe-scoped hook would leave
// the refund block's rows behind.
const TEST_TAG = "test-resolve-int";
const taggedOrder = () => `${TEST_TAG}-o-${randomUUID()}`;

afterAll(async () => {
  // PaymentAttempt cascades from Payment (onDelete: Cascade in schema.prisma);
  // Outbox has no FK to it, so it is deleted explicitly.
  await prisma.outbox.deleteMany({ where: { aggregateId: { startsWith: TEST_TAG } } });
  await prisma.payment.deleteMany({ where: { orderId: { startsWith: TEST_TAG } } });
});

const postWebhook = (body: object) =>
  request(app)
    .post("/webhooks/payment")
    .set("x-webhook-signature", signWebhookBody(body))
    .send(body);
const seedProcessing = async (amount = 599): Promise<string> => {
  const orderId = taggedOrder();
  await prisma.payment.create({ data: { orderId, amount, status: "PROCESSING" } });
  return orderId;
};
const outbox = (orderId: string, type: string) =>
  prisma.outbox.count({ where: { aggregateId: orderId, type } });
const statusOf = async (orderId: string) =>
  (await prisma.payment.findUnique({ where: { orderId } }))?.status;

describe("payment webhook (integration — needs compose up + migrated)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("SUCCEEDED webhook finalizes a PROCESSING payment + emits payment.succeeded", async () => {
    const orderId = await seedProcessing();
    const res = await postWebhook({ orderId, outcome: "SUCCEEDED" });
    expect(res.status).toBe(200);
    expect(await statusOf(orderId)).toBe("SUCCEEDED");
    expect(await outbox(orderId, PAYMENT_SUCCEEDED)).toBe(1);
  });

  it("FAILED webhook emits payment.failed", async () => {
    const orderId = await seedProcessing();
    await postWebhook({ orderId, outcome: "FAILED" });
    expect(await statusOf(orderId)).toBe("FAILED");
    expect(await outbox(orderId, PAYMENT_FAILED)).toBe(1);
  });

  it("redelivered webhook is an idempotent no-op (one event)", async () => {
    const orderId = await seedProcessing();
    await postWebhook({ orderId, outcome: "SUCCEEDED" });
    const res2 = await postWebhook({ orderId, outcome: "SUCCEEDED" });
    expect(res2.status).toBe(200);
    expect(await outbox(orderId, PAYMENT_SUCCEEDED)).toBe(1);
  });

  it("unknown order -> 404; malformed body -> 400", async () => {
    const r404 = await postWebhook({
      orderId: taggedOrder(),
      outcome: "SUCCEEDED",
    });
    expect(r404.status).toBe(404);
    const r400 = await postWebhook({ orderId: "o1" });
    expect(r400.status).toBe(400);
  });
});

async function seedSucceeded(amount = 500): Promise<string> {
  const orderId = taggedOrder();
  await prisma.payment.create({ data: { orderId, amount, status: "SUCCEEDED" } });
  return orderId;
}

describe("payment refund (integration)", () => {
  it("refunds a SUCCEEDED payment + emits payment.refunded", async () => {
    const orderId = await seedSucceeded();
    const res = await request(app).post(`/admin/payments/${orderId}/refund`).send();
    expect(res.status).toBe(200);
    expect(await statusOf(orderId)).toBe("REFUNDED");
    expect(await outbox(orderId, PAYMENT_REFUNDED)).toBe(1);
  });
  it("double refund is idempotent (one event)", async () => {
    const orderId = await seedSucceeded();
    await request(app).post(`/admin/payments/${orderId}/refund`).send();
    const res2 = await request(app).post(`/admin/payments/${orderId}/refund`).send();
    expect(res2.status).toBe(200);
    expect(await outbox(orderId, PAYMENT_REFUNDED)).toBe(1);
  });
  it("refunding a PROCESSING payment -> 409; unknown -> 404", async () => {
    const proc = await seedProcessing();
    expect(
      (await request(app).post(`/admin/payments/${proc}/refund`).send()).status
    ).toBe(409);
    expect(
      (await request(app).post(`/admin/payments/${taggedOrder()}/refund`).send()).status
    ).toBe(404);
  });
});
