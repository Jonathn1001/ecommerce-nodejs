import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../db";

const app = createApp();
async function seedProduct(): Promise<string> {
  const r = await request(app).post("/products").send({ type: "ELECTRONICS", name: "P", price: 100, attributes: { manufacturer: "Acme" } });
  return r.body.productId;
}

describe("catalog comments (integration)", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("threads replies and returns the nested tree", async () => {
    const pid = await seedProduct();
    const root = (await request(app).post(`/products/${pid}/comments`).send({ body: "root" })).body.id;
    const child = (await request(app).post(`/products/${pid}/comments`).send({ body: "child", parentId: root })).body.id;
    await request(app).post(`/products/${pid}/comments`).send({ body: "grandchild", parentId: child });
    const tree = (await request(app).get(`/products/${pid}/comments`)).body;
    expect(tree[0].children[0].children[0].body).toBe("grandchild");
  });

  it("DELETE removes the whole subtree (cascade)", async () => {
    const pid = await seedProduct();
    const root = (await request(app).post(`/products/${pid}/comments`).send({ body: "root" })).body.id;
    const child = (await request(app).post(`/products/${pid}/comments`).send({ body: "child", parentId: root })).body.id;
    await request(app).delete(`/comments/${root}`);
    expect(await prisma.comment.count({ where: { id: { in: [root, child] } } })).toBe(0);
  });

  it("bad parent -> 400; unknown product -> 404", async () => {
    const pid = await seedProduct();
    expect((await request(app).post(`/products/${pid}/comments`).send({ body: "x", parentId: "nope" })).status).toBe(400);
    expect((await request(app).post(`/products/ghost/comments`).send({ body: "x" })).status).toBe(404);
  });
});
