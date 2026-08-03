import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../db";
import { ProductListItemSchema, ProductDetailSchema } from "@ecom/contracts";

const app = createApp();

// Catalog asserting its OWN responses against the shared schemas is what makes the storefront
// safe. A client that only validates on its side discovers drift at runtime, in a browser, as
// a blank grid. Here, drift fails a backend test next to the change that caused it.
const TEST_TAG = "test-catalog-contract-int";

describe("catalog read API satisfies the shared contracts", () => {
  afterAll(async () => {
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

  it("GET /products items satisfy ProductListItemSchema", async () => {
    await request(app)
      .post("/products")
      .send({
        type: "ELECTRONICS",
        name: `${TEST_TAG}-list`,
        price: 900,
        attributes: { manufacturer: "Acme" },
      })
      .expect(201);

    const res = await request(app).get("/products").expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const item of res.body) {
      const parsed = ProductListItemSchema.safeParse(item);
      if (!parsed.success) throw new Error(`list item drifted: ${parsed.error.message}`);
    }
  });

  it("GET /products/:id satisfies ProductDetailSchema, including attributes", async () => {
    const created = await request(app)
      .post("/products")
      .send({
        type: "CLOTHING",
        name: `${TEST_TAG}-detail`,
        price: 2450,
        attributes: { brand: "Acme", size: "M", material: "cotton", color: "blue" },
      })
      .expect(201);

    const res = await request(app).get(`/products/${created.body.productId}`).expect(200);
    const parsed = ProductDetailSchema.safeParse(res.body);
    if (!parsed.success) throw new Error(`detail drifted: ${parsed.error.message}`);
    expect(parsed.data.attributes).toMatchObject({ brand: "Acme" });
    expect(parsed.data.price).toBe(2450);
  });
});
