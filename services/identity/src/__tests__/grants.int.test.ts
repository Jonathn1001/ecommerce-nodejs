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

  // Guards the seed against the gateway's rules table drifting away from it. The gateway
  // suite verifies enforcement against a FAKE snapshot, so a permission the gateway demands
  // but the seed never creates fails only in a real deployment (403 forever, silently).
  // Requires the seed to have run — CI seeds before this suite.
  it("the seed grants ADMIN every permission the gateway enforces", async () => {
    const res = await request(app).get("/internal/grants").expect(200);
    const admin = (res.body as Record<string, Record<string, string[]>>).ADMIN ?? {};
    // Mirrors RULES in services/gateway/src/authz.ts — change both together.
    const required: Array<[string, string]> = [
      ["catalog.product", "create"],
      ["catalog.product", "update"],
      ["catalog.discount", "create"],
      ["catalog.comment", "delete"],
      ["payment.refund", "create"],
    ];
    for (const [resource, action] of required)
      expect(admin[resource] ?? []).toContain(action);
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
