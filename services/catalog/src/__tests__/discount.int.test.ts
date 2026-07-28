import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { prisma } from "../db";

const app = createApp();
async function mkDiscount(over: Partial<any> = {}): Promise<string> {
  const code = `D_${randomUUID().slice(0, 8)}`;
  await request(app)
    .post("/discounts")
    .send({
      code,
      kind: "PERCENT",
      value: 10,
      minOrder: 100,
      maxUses: 3,
      maxPerUser: 1,
      expiresAt: "2030-01-01T00:00:00.000Z",
      ...over,
    });
  return code;
}

describe("catalog discounts (integration)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("apply returns amount + records a redemption; per-user limit -> 409", async () => {
    const code = await mkDiscount();
    const u = `u_${randomUUID()}`;
    const r1 = await request(app)
      .post(`/discounts/${code}/apply`)
      .send({ userId: u, orderTotal: 1000 });
    expect(r1.status).toBe(200);
    expect(r1.body.amount).toBe(100);
    const r2 = await request(app)
      .post(`/discounts/${code}/apply`)
      .send({ userId: u, orderTotal: 1000 });
    expect(r2.status).toBe(409); // maxPerUser=1
  });

  it("concurrent applies never exceed maxUses (row lock)", async () => {
    const code = await mkDiscount({ maxUses: 3, maxPerUser: 10 });
    const applies = Array.from({ length: 10 }, (_, i) =>
      request(app)
        .post(`/discounts/${code}/apply`)
        .send({ userId: `u${i}`, orderTotal: 1000 })
    );
    const results = await Promise.all(applies);
    const ok = results.filter((r) => r.status === 200).length;
    expect(ok).toBe(3); // exactly maxUses, never more
    const d = await prisma.discount.findUnique({
      where: { code },
      include: { redemptions: true },
    });
    expect(d!.redemptions.length).toBe(3);
  });

  it("below minOrder -> 409; unknown code -> 404", async () => {
    const code = await mkDiscount({ minOrder: 500 });
    expect(
      (
        await request(app)
          .post(`/discounts/${code}/apply`)
          .send({ userId: "u", orderTotal: 100 })
      ).status
    ).toBe(409);
    expect(
      (
        await request(app)
          .post(`/discounts/nope/apply`)
          .send({ userId: "u", orderTotal: 100 })
      ).status
    ).toBe(404);
  });
});
