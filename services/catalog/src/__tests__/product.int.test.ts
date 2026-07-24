import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../db";
import {
  CATALOG_PRODUCT_CREATED,
  CATALOG_PRODUCT_UPDATED,
  CATALOG_PRICE_CHANGED,
} from "@ecom/contracts";

const app = createApp();
const outbox = (pid: string, type: string) =>
  prisma.outbox.count({ where: { aggregateId: pid, type } });

describe("catalog product CRUD + events (integration)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("POST /products -> product_created; PATCH price -> product_updated + price_changed", async () => {
    const create = await request(app)
      .post("/products")
      .send({
        type: "ELECTRONICS",
        name: "Widget",
        price: 500,
        attributes: { manufacturer: "Acme" },
      });
    expect(create.status).toBe(201);
    const pid = create.body.productId;
    expect(await outbox(pid, CATALOG_PRODUCT_CREATED)).toBe(1);

    const patch = await request(app).patch(`/products/${pid}`).send({ price: 900 });
    expect(patch.status).toBe(200);
    expect(await outbox(pid, CATALOG_PRODUCT_UPDATED)).toBe(1);
    expect(await outbox(pid, CATALOG_PRICE_CHANGED)).toBe(1);
    const p = await prisma.product.findUnique({ where: { id: pid } });
    expect(p!.version).toBe(2);
  });

  it("name-only PATCH emits no price_changed", async () => {
    const create = await request(app)
      .post("/products")
      .send({
        type: "CLOTHING",
        name: "Shirt",
        price: 300,
        attributes: { brand: "Acme" },
      });
    const pid = create.body.productId;
    await request(app).patch(`/products/${pid}`).send({ name: "Shirt v2" });
    expect(await outbox(pid, CATALOG_PRICE_CHANGED)).toBe(0);
  });

  it("invalid attributes -> 400, no product", async () => {
    const r = await request(app)
      .post("/products")
      .send({ type: "ELECTRONICS", name: "x", price: 100, attributes: {} });
    expect(r.status).toBe(400);
  });
});
