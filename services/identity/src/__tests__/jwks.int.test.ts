import "./test-key";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app";
import { prisma } from "../db";

const app = createApp();

// Tag the EMAIL rather than the user id: the id is minted by the service, so the test
// never chooses it and cannot tag it. afterAll resolves the tag to ids with a DB query,
// which is also why a mid-suite throw still gets cleaned up. Registering enqueues a
// user_registered outbox row keyed by the new user's id, and no relay runs during an
// integration test, so it sits unsent and INV4_OUTBOX_UNSENT reports it.
const TEST_TAG = "test-jwks-int";

describe("JWKS", () => {
  it("publishes the active public key with a kid that matches the token header", async () => {
    const res = await request(app).get("/.well-known/jwks.json").expect(200);
    const keys = (res.body as { keys: Array<{ kid: string; kty: string; alg: string }> })
      .keys;
    expect(keys.length).toBeGreaterThan(0);
    expect(keys[0].kty).toBe("RSA");
    expect(keys[0].alg).toBe("RS256");

    const login = await request(app)
      .post("/auth/login")
      .send({ email: "nobody@example.test", password: "wrongwrongwrong" });
    expect([401, 200]).toContain(login.status); // credentials are irrelevant here

    const token = jwt.sign({ sub: "u1", role: "USER" }, process.env.JWT_PRIVATE_KEY!, {
      algorithm: "RS256",
      keyid: keys[0].kid,
    });
    expect(
      (jwt.decode(token, { complete: true }) as { header: { kid: string } }).header.kid
    ).toBe(keys[0].kid);
  });

  describe("a real login-issued token (integration — needs compose up + migrated + seeded)", () => {
    beforeAll(async () => {
      // The suite depends on the USER role existing, exactly as the service does.
      await prisma.role.upsert({
        where: { name: "USER" },
        create: { name: "USER" },
        update: {},
      });
    });
    afterAll(async () => {
      // RefreshToken cascades from User (onDelete: Cascade in schema.prisma); Outbox has no
      // FK to it, so it is deleted explicitly, keyed by the user ids the tag resolves to.
      // The upserted USER Role is deliberately left alone — the service depends on it.
      const seeded = await prisma.user.findMany({
        where: { email: { startsWith: TEST_TAG } },
        select: { id: true },
      });
      const ids = seeded.map((u) => u.id);
      if (ids.length > 0) {
        await prisma.outbox.deleteMany({ where: { aggregateId: { in: ids } } });
        await prisma.user.deleteMany({ where: { id: { in: ids } } });
      }
      await prisma.$disconnect();
    });

    it("carries a kid the JWKS actually publishes, not just a hand-signed one", async () => {
      const email = `${TEST_TAG}-${randomUUID()}@example.test`;
      await request(app)
        .post("/auth/register")
        .send({ email, password: "hunter2hunter2", name: "T" })
        .expect(201);
      const login = await request(app)
        .post("/auth/login")
        .send({ email, password: "hunter2hunter2" })
        .expect(200);

      const decoded = jwt.decode((login.body as { accessToken: string }).accessToken, {
        complete: true,
      }) as { header: { kid?: string } };
      const jwks = await request(app).get("/.well-known/jwks.json").expect(200);
      const kids = (jwks.body as { keys: Array<{ kid: string }> }).keys.map((k) => k.kid);

      expect(decoded.header.kid).toBeTruthy();
      expect(kids).toContain(decoded.header.kid);
    });
  });
});
