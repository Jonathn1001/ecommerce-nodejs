import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../db";

const app = createApp();

// Tag the product NAME rather than the id: the id is minted by the service, so the test
// never chooses it and cannot tag it. afterAll resolves the tag to ids with a DB query,
// which is also why a mid-suite throw still gets cleaned up. Every seedProduct() call
// enqueues a product_created outbox row, and no relay runs during an integration test, so
// each one sits unsent and INV4_OUTBOX_UNSENT reports it. The name was the bare literal
// "P" before the tag; no assertion here reads a product name.
const TEST_TAG = "test-catalog-comments-int";

async function seedProduct(): Promise<string> {
  const r = await request(app)
    .post("/products")
    .send({
      type: "ELECTRONICS",
      name: TEST_TAG,
      price: 100,
      attributes: { manufacturer: "Acme" },
    });
  return r.body.productId;
}

describe("catalog comments (integration)", () => {
  afterAll(async () => {
    // Comment cascades from Product (onDelete: Cascade in schema.prisma), which is exactly
    // what the subtree test relies on; Outbox has no FK to it, so it is deleted explicitly,
    // keyed by the product ids the tag resolves to.
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

  it("threads replies and returns the nested tree", async () => {
    const pid = await seedProduct();
    const root = (
      await request(app).post(`/products/${pid}/comments`).send({ body: "root" })
    ).body.id;
    const child = (
      await request(app)
        .post(`/products/${pid}/comments`)
        .send({ body: "child", parentId: root })
    ).body.id;
    await request(app)
      .post(`/products/${pid}/comments`)
      .send({ body: "grandchild", parentId: child });
    const tree = (await request(app).get(`/products/${pid}/comments`)).body;
    expect(tree[0].children[0].children[0].body).toBe("grandchild");
  });

  it("DELETE removes the whole subtree (cascade)", async () => {
    const pid = await seedProduct();
    const root = (
      await request(app).post(`/products/${pid}/comments`).send({ body: "root" })
    ).body.id;
    const child = (
      await request(app)
        .post(`/products/${pid}/comments`)
        .send({ body: "child", parentId: root })
    ).body.id;
    await request(app).delete(`/comments/${root}`);
    expect(await prisma.comment.count({ where: { id: { in: [root, child] } } })).toBe(0);
  });

  it("bad parent -> 400; unknown product -> 404", async () => {
    const pid = await seedProduct();
    expect(
      (
        await request(app)
          .post(`/products/${pid}/comments`)
          .send({ body: "x", parentId: "nope" })
      ).status
    ).toBe(400);
    expect(
      (await request(app).post(`/products/ghost/comments`).send({ body: "x" })).status
    ).toBe(404);
  });

  it("empty parentId -> 400 (does not crash the process)", async () => {
    const pid = await seedProduct();
    expect(
      (
        await request(app)
          .post(`/products/${pid}/comments`)
          .send({ body: "x", parentId: "" })
      ).status
    ).toBe(400);
  });
});
