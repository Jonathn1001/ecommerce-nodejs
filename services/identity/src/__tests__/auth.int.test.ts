// MUST come first: it plants JWT_PRIVATE_KEY before ../app validates its config.
import { TEST_PUBLIC_KEY } from "./test-key";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import jwt from "jsonwebtoken";
import type express from "express";
import { IDENTITY_USER_REGISTERED } from "@ecom/contracts";
import { createApp } from "../app";
import { prisma } from "../db";

const email = () => `u_${randomUUID()}@example.test`;

describe("identity auth (integration — needs compose up + migrated + seeded)", () => {
  let app: express.Application;

  beforeAll(async () => {
    app = createApp();
    // The suite depends on the USER role existing, exactly as the service does.
    await prisma.role.upsert({
      where: { name: "USER" },
      create: { name: "USER" },
      update: {},
    });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function registerAndLogin() {
    const e = email();
    await request(app)
      .post("/auth/register")
      .send({ email: e, password: "hunter2hunter2", name: "T" })
      .expect(201);
    const res = await request(app)
      .post("/auth/login")
      .send({ email: e, password: "hunter2hunter2" })
      .expect(200);
    return { email: e, ...(res.body as { accessToken: string; refreshToken: string }) };
  }

  it("register writes the user AND the outbox event in one tx; the access token verifies with the public key", async () => {
    const e = email();
    const res = await request(app)
      .post("/auth/register")
      .send({ email: e, password: "hunter2hunter2", name: "T" })
      .expect(201);
    const userId = res.body.userId as string;

    expect(
      await prisma.outbox.count({
        where: { aggregateId: userId, type: IDENTITY_USER_REGISTERED },
      })
    ).toBe(1);

    const login = await request(app)
      .post("/auth/login")
      .send({ email: e, password: "hunter2hunter2" })
      .expect(200);
    const claims = jwt.verify(login.body.accessToken, TEST_PUBLIC_KEY, {
      algorithms: ["RS256"],
    }) as jwt.JwtPayload;
    expect(claims.sub).toBe(userId);
    expect(claims.role).toBe("USER");
  });

  it("rejects a duplicate email with 409 and a short password with 400", async () => {
    const e = email();
    await request(app)
      .post("/auth/register")
      .send({ email: e, password: "hunter2hunter2", name: "T" })
      .expect(201);
    await request(app)
      .post("/auth/register")
      .send({ email: e, password: "hunter2hunter2", name: "T" })
      .expect(409);
    await request(app)
      .post("/auth/register")
      .send({ email: email(), password: "short", name: "T" })
      .expect(400);
  });

  it("answers unknown-email and bad-password identically", async () => {
    const { email: e } = await registerAndLogin();
    const bad = await request(app)
      .post("/auth/login")
      .send({ email: e, password: "wrongwrongwrong" })
      .expect(401);
    const unknown = await request(app)
      .post("/auth/login")
      .send({ email: email(), password: "wrongwrongwrong" })
      .expect(401);
    expect(bad.body).toEqual(unknown.body);
  });

  it("refresh rotates: the old token is dead, the new one works", async () => {
    const s = await registerAndLogin();
    const first = await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: s.refreshToken })
      .expect(200);
    expect(first.body.refreshToken).not.toBe(s.refreshToken);
    await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: first.body.refreshToken })
      .expect(200);
  });

  it("replaying a rotated token is reuse: 401, and it kills that family only", async () => {
    const deviceA = await registerAndLogin();
    // Second login for the same user = a second family (a second device).
    const deviceB = await request(app)
      .post("/auth/login")
      .send({ email: deviceA.email, password: "hunter2hunter2" })
      .expect(200);

    const rotated = await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: deviceA.refreshToken })
      .expect(200);
    // Replay of the consumed token -> reuse detected.
    await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: deviceA.refreshToken })
      .expect(401);
    // ...which also kills the live token in that same family.
    await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: rotated.body.refreshToken })
      .expect(401);
    // ...but device B is untouched.
    await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: deviceB.body.refreshToken })
      .expect(200);
  });

  it("logout revokes only the session it was given", async () => {
    const a = await registerAndLogin();
    const b = await request(app)
      .post("/auth/login")
      .send({ email: a.email, password: "hunter2hunter2" })
      .expect(200);
    await request(app)
      .post("/auth/logout")
      .send({ refreshToken: a.refreshToken })
      .expect(204);
    await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: a.refreshToken })
      .expect(401);
    await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: b.body.refreshToken })
      .expect(200);
  });

  it("two concurrent refreshes of the same token never leave two live tokens in a family", async () => {
    const s = await registerAndLogin();
    const both = await Promise.all([
      request(app).post("/auth/refresh").send({ refreshToken: s.refreshToken }),
      request(app).post("/auth/refresh").send({ refreshToken: s.refreshToken }),
    ]);
    const ok = both.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1); // the loser is rejected, never silently given a second chain

    // The security property: a thief racing the honest client cannot end up with a parallel
    // session. Depending on which interleaving happens, the loser either loses the row claim
    // (RACE -> 401, family intact) or reads the winner's committed revoke and treats it as
    // reuse (-> the family is revoked and BOTH clients must log in again). Either way the
    // count of live tokens is never 2 — see "Known limitations" in the spec.
    const userId = (jwt.decode(s.accessToken) as jwt.JwtPayload).sub as string;
    const live = await prisma.refreshToken.count({
      where: { userId, revokedAt: null },
    });
    expect(live).toBeLessThanOrEqual(1);
  });

  it("an unknown refresh token is 401 and revokes nothing", async () => {
    const s = await registerAndLogin();
    await request(app).post("/auth/refresh").send({ refreshToken: "nope" }).expect(401);
    await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: s.refreshToken })
      .expect(200);
  });
});
