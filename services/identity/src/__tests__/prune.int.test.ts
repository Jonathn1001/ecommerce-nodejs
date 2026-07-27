import "./test-key";
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { refreshTokenPrunerPort } from "../prune-adapter";
import { prisma } from "../db";

const DAY = 24 * 3600_000;

describe("refresh token pruning (integration — needs compose up + migrated)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("deletes expired and long-revoked rows, keeps live and recently-revoked ones", async () => {
    const role = await prisma.role.upsert({
      where: { name: "USER" },
      create: { name: "USER" },
      update: {},
    });
    const user = await prisma.user.create({
      data: {
        email: `u_${randomUUID()}@example.test`,
        password: "x",
        name: "T",
        roleId: role.id,
      },
    });
    const mk = (over: Partial<{ revokedAt: Date | null; expiresAt: Date }>) =>
      prisma.refreshToken.create({
        data: {
          tokenHash: randomUUID(),
          userId: user.id,
          familyId: randomUUID(),
          expiresAt: new Date(Date.now() + 7 * DAY),
          ...over,
        },
      });

    const live = await mk({});
    const expired = await mk({ expiresAt: new Date(Date.now() - DAY) });
    const recentlyRevoked = await mk({ revokedAt: new Date() });
    const oldRevoked = await mk({ revokedAt: new Date(Date.now() - 40 * DAY) });
    // Both revoked AND already expired (e.g. logout() on an already-expired token, which sets
    // revokedAt with no expiry filter). The expiry arm must not reach a revoked row: reuse-
    // detection has to find it until the retention window passes, same as recentlyRevoked.
    const recentlyRevokedAndExpired = await mk({
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() - DAY),
    });

    await refreshTokenPrunerPort.deleteOlderThan(new Date(Date.now() - 30 * DAY));

    const survivors = await prisma.refreshToken.findMany({ where: { userId: user.id } });
    const ids = survivors.map((r) => r.id);
    expect(ids).toContain(live.id);
    expect(ids).toContain(recentlyRevoked.id); // reuse-detection still needs to find it
    expect(ids).toContain(recentlyRevokedAndExpired.id); // same — expired doesn't override revoked
    expect(ids).not.toContain(expired.id);
    expect(ids).not.toContain(oldRevoked.id);
  });
});
