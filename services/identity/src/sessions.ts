export type SessionRow = {
  id: string;
  tokenHash: string;
  userId: string;
  familyId: string;
  revokedAt: Date | null;
  replacedBy?: string | null;
  expiresAt: Date;
};

export interface SessionTx {
  findByHash(tokenHash: string): Promise<SessionRow | null>;
  revokeFamily(familyId: string, at: Date): Promise<void>;
  revokeOne(id: string, at: Date): Promise<void>;
  mintInFamily(n: {
    tokenHash: string;
    userId: string;
    familyId: string;
    expiresAt: Date;
  }): Promise<string>;
  linkReplacement(oldId: string, newId: string): Promise<void>;
}

export type RotateOutcome = "ROTATED" | "UNKNOWN" | "REUSE" | "EXPIRED";

export type RotateResult = {
  outcome: RotateOutcome;
  tokenHash?: string;
  userId?: string;
};

// Domain core over a tx port (no prisma, no config) — the same shape as order/transition.ts.
// Preserves the legacy rotation + reuse-detection behavior, but scoped to one rotation chain
// instead of the whole user: presenting an already-rotated token means the chain leaked, so
// the family dies (including whoever is holding the current token) while other devices live.
export async function rotateRefresh(
  tx: SessionTx,
  presentedHash: string,
  now: Date,
  mintHash: () => string,
  ttlMs = 7 * 24 * 3600_000
): Promise<RotateResult> {
  const row = await tx.findByHash(presentedHash);
  if (row === null) return { outcome: "UNKNOWN" };

  if (row.revokedAt !== null) {
    await tx.revokeFamily(row.familyId, now);
    return { outcome: "REUSE", userId: row.userId };
  }

  if (row.expiresAt.getTime() <= now.getTime()) {
    await tx.revokeOne(row.id, now);
    return { outcome: "EXPIRED", userId: row.userId };
  }

  const tokenHash = mintHash();
  const newId = await tx.mintInFamily({
    tokenHash,
    userId: row.userId,
    familyId: row.familyId,
    expiresAt: new Date(now.getTime() + ttlMs),
  });
  await tx.revokeOne(row.id, now);
  await tx.linkReplacement(row.id, newId);
  return { outcome: "ROTATED", tokenHash, userId: row.userId };
}
