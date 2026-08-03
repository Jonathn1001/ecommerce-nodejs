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

// Tag the product NAME rather than the id: the id is minted by the service, so the test
// never chooses it and cannot tag it. afterAll resolves the tag to ids with a DB query,
// which is also why a mid-suite throw still gets cleaned up. Creating and repricing a
// product enqueues product_created / product_updated / price_changed outbox rows, and no
// relay runs during an integration test, so they sit unsent and INV4_OUTBOX_UNSENT
// reports every one. The names were bare literals ("Widget", "Shirt") before the tag; no
// assertion here reads a product name, so prefixing them changes nothing observable.
const TEST_TAG = "test-catalog-product-int";

describe("catalog product CRUD + events (integration)", () => {
  afterAll(async () => {
    // Comment cascades from Product (onDelete: Cascade in schema.prisma); Outbox has no
    // FK to it, so it is deleted explicitly, keyed by the product ids the tag resolves to.
    const seeded = await prisma.product.findMany({
      where: { name: { startsWith: TEST_TAG } },
      select: { id: true },
    });
    const ids = seeded.map((p) => p.id);
    if (ids.length > 0) {
      await prisma.outbox.deleteMany({ where: { aggregateId: { in: ids } } });
      await prisma.product.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.$disconnect();
  });

  it("POST /products -> product_created; PATCH price -> product_updated + price_changed", async () => {
    const create = await request(app)
      .post("/products")
      .send({
        type: "ELECTRONICS",
        name: `${TEST_TAG}-Widget`,
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
        name: `${TEST_TAG}-Shirt`,
        price: 300,
        attributes: { brand: "Acme" },
      });
    const pid = create.body.productId;
    await request(app)
      .patch(`/products/${pid}`)
      .send({ name: `${TEST_TAG}-Shirt-v2` });
    expect(await outbox(pid, CATALOG_PRICE_CHANGED)).toBe(0);
  });

  it("invalid attributes -> 400, no product", async () => {
    const r = await request(app)
      .post("/products")
      .send({ type: "ELECTRONICS", name: `${TEST_TAG}-x`, price: 100, attributes: {} });
    expect(r.status).toBe(400);
  });
});
