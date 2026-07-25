import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { IDENTITY_USER_REGISTERED } from "@ecom/contracts";
import { prisma } from "./db";
import { config } from "./config";
import { sessionTx, outboxEnqueue } from "./tx-adapters";
import { rotateRefresh } from "./sessions";
import { createTokenIssuer } from "./tokens";

const issuer = createTokenIssuer({
  privateKey: config.JWT_PRIVATE_KEY,
  accessTtl: config.ACCESS_TTL,
});

const refreshTtlMs = () => config.REFRESH_TTL_DAYS * 24 * 3600_000;

export type TokenPair = { accessToken: string; refreshToken: string };

async function issuePair(userId: string, role: string): Promise<TokenPair> {
  const { token, tokenHash } = issuer.mintRefresh();
  await prisma.refreshToken.create({
    data: {
      tokenHash,
      userId,
      familyId: randomUUID(), // a login starts a new rotation chain (= a new device)
      expiresAt: new Date(Date.now() + refreshTtlMs()),
    },
  });
  return { accessToken: issuer.signAccess({ sub: userId, role }), refreshToken: token };
}

export async function register(p: {
  email: string;
  password: string;
  name: string;
  traceId: string;
}): Promise<{ outcome: "CREATED" | "DUPLICATE"; userId?: string }> {
  const role = await prisma.role.findUnique({ where: { name: "USER" } });
  if (!role) throw new Error("role_user_missing"); // seed has not been run
  const password = await bcrypt.hash(p.password, config.BCRYPT_COST);
  try {
    const userId = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: p.email, password, name: p.name, roleId: role.id },
      });
      // The event commits with the row — no dual write.
      await outboxEnqueue(tx, p.traceId, IDENTITY_USER_REGISTERED, user.id, {
        userId: user.id,
        email: user.email,
      });
      return user.id;
    });
    return { outcome: "CREATED", userId };
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return { outcome: "DUPLICATE" };
    throw e;
  }
}

export async function login(p: {
  email: string;
  password: string;
}): Promise<{ outcome: "OK" | "REJECTED"; tokens?: TokenPair; userId?: string }> {
  const user = await prisma.user.findUnique({
    where: { email: p.email },
    include: { role: true },
  });
  // Same answer for unknown-email and bad-password: never leak which one it was. bcrypt is
  // still run on a dummy hash so the timing does not leak account existence either.
  const hash =
    user?.password ?? "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
  const ok = await bcrypt.compare(p.password, hash);
  if (!user || !ok || user.status !== "ACTIVE") return { outcome: "REJECTED" };
  return {
    outcome: "OK",
    tokens: await issuePair(user.id, user.role.name),
    userId: user.id,
  };
}

export async function refresh(
  presented: string
): Promise<{ outcome: "OK" | "REJECTED"; tokens?: TokenPair; reason?: string }> {
  const presentedHash = issuer.hashRefresh(presented);
  const minted = issuer.mintRefresh();
  const result = await prisma.$transaction((tx) =>
    rotateRefresh(
      sessionTx(tx),
      presentedHash,
      new Date(),
      () => minted.tokenHash,
      refreshTtlMs()
    )
  );
  if (result.outcome !== "ROTATED")
    return { outcome: "REJECTED", reason: result.outcome };

  const user = await prisma.user.findUnique({
    where: { id: result.userId! },
    include: { role: true },
  });
  if (!user) return { outcome: "REJECTED", reason: "UNKNOWN_USER" };
  return {
    outcome: "OK",
    tokens: {
      accessToken: issuer.signAccess({ sub: user.id, role: user.role.name }),
      refreshToken: minted.token,
    },
  };
}

export async function logout(presented: string): Promise<void> {
  // Revokes this session only — other devices keep their own families.
  await prisma.refreshToken.updateMany({
    where: { tokenHash: issuer.hashRefresh(presented), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
