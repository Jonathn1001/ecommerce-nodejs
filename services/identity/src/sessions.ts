export type SessionRow = {
  id: string;
  tokenHash: string;
  userId: string;
  familyId: string;
  revokedAt: Date | null;
  replacedBy?: string | null;
  replacedAt: Date | null;
  expiresAt: Date;
};

export interface SessionTx {
  findByHash(tokenHash: string): Promise<SessionRow | null>;
  revokeFamily(familyId: string, at: Date): Promise<void>;
  // Returns the number of rows it actually revoked. 0 means someone else revoked this row
  // first — the caller must treat that as a lost race, not as success. Pass `rotated: true`
  // only when this revocation IS a rotation (the row is being replaced) — it stamps
  // `replacedAt` so the grace window can later tell "rotated" apart from "revoked by logout".
  revokeOne(id: string, at: Date, rotated?: boolean): Promise<number>;
  mintInFamily(n: {
    tokenHash: string;
    userId: string;
    familyId: string;
    expiresAt: Date;
  }): Promise<string>;
  linkReplacement(oldId: string, newId: string): Promise<void>;
}

export type RotateOutcome =
  "ROTATED" | "UNKNOWN" | "REUSE" | "EXPIRED" | "RACE" | "GRACE";

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
  ttlMs = 7 * 24 * 3600_000,
  graceMs = 10_000
): Promise<RotateResult> {
  const row = await tx.findByHash(presentedHash);
  if (row === null) return { outcome: "UNKNOWN" };

  if (row.revokedAt !== null) {
    // A rotation this recent is far more likely an honest double-submit (two tabs, a retry)
    // than a thief replaying a stolen token, and revoking the family would log the real user
    // out. Outside the window — or if the row was revoked by logout rather than rotated —
    // reuse-detection fires as before. This narrows detection by graceMs, deliberately.
    const rotatedAt = row.replacedAt?.getTime();
    if (rotatedAt !== undefined && now.getTime() - rotatedAt <= graceMs) {
      return { outcome: "GRACE", userId: row.userId };
    }
    await tx.revokeFamily(row.familyId, now);
    return { outcome: "REUSE", userId: row.userId };
  }

  if (row.expiresAt.getTime() <= now.getTime()) {
    await tx.revokeOne(row.id, now);
    return { outcome: "EXPIRED", userId: row.userId };
  }

  // Claim the row FIRST. Under READ COMMITTED two concurrent rotations of the same token
  // both read revokedAt === null; whichever revoke commits second matches zero rows. Without
  // this check both would mint, leaving two live tokens in one family — and a thief racing
  // the honest client would never trip reuse-detection, which is the whole point of the
  // mechanism. The loser rolls back (the caller throws) and gets a 401.
  const claimed = await tx.revokeOne(row.id, now, true);
  if (claimed === 0) return { outcome: "RACE", userId: row.userId };

  const tokenHash = mintHash();
  const newId = await tx.mintInFamily({
    tokenHash,
    userId: row.userId,
    familyId: row.familyId,
    expiresAt: new Date(now.getTime() + ttlMs),
  });
  await tx.linkReplacement(row.id, newId);
  return { outcome: "ROTATED", tokenHash, userId: row.userId };
}
