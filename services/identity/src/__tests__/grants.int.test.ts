// MUST come first: it plants JWT_PRIVATE_KEY before ../app validates its config.
import "./test-key";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import type express from "express";
import { createApp } from "../app";
import { prisma } from "../db";

describe("identity grants (integration — needs compose up + migrated)", () => {
  let app: express.Application;
  const roleName = `ROLE_${randomUUID().slice(0, 8)}`;
  const resourceName = `res.${randomUUID().slice(0, 8)}`;

  beforeAll(() => {
    app = createApp();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates a role and a resource, rejecting duplicates with 409", async () => {
    await request(app).post("/admin/roles").send({ name: roleName }).expect(201);
    await request(app).post("/admin/roles").send({ name: roleName }).expect(409);
    await request(app).post("/admin/resources").send({ name: resourceName }).expect(201);
    await request(app).post("/admin/resources").send({ name: resourceName }).expect(409);
    await request(app).post("/admin/roles").send({}).expect(400);
  });

  it("grants an action, rejects the duplicate pair, and 404s an unknown role", async () => {
    await request(app)
      .post("/admin/grants")
      .send({ roleName, resourceName, action: "create" })
      .expect(201);
    await request(app)
      .post("/admin/grants")
      .send({ roleName, resourceName, action: "create" })
      .expect(409);
    await request(app)
      .post("/admin/grants")
      .send({ roleName: "NO_SUCH_ROLE", resourceName, action: "create" })
      .expect(404);
    await request(app)
      .post("/admin/grants")
      .send({ roleName, resourceName, action: "fly" })
      .expect(400);
  });

  it("the internal snapshot nests role -> resource -> actions", async () => {
    await request(app)
      .post("/admin/grants")
      .send({ roleName, resourceName, action: "update" })
      .expect(201);
    const res = await request(app).get("/internal/grants").expect(200);
    const snapshot = res.body as Record<string, Record<string, string[]>>;
    expect(snapshot[roleName][resourceName].sort()).toEqual(["create", "update"]);
  });

  it("deleting a grant removes it from the snapshot", async () => {
    const list = await request(app).get("/admin/grants").expect(200);
    const mine = (
      list.body as Array<{ id: string; role: { name: string }; action: string }>
    ).filter((g) => g.role.name === roleName && g.action === "update");
    await request(app).delete(`/admin/grants/${mine[0].id}`).expect(204);
    const res = await request(app).get("/internal/grants").expect(200);
    expect(
      (res.body as Record<string, Record<string, string[]>>)[roleName][resourceName]
    ).toEqual(["create"]);
    await request(app).delete(`/admin/grants/${mine[0].id}`).expect(404);
  });
});
