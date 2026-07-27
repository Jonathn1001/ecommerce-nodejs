import type { LedgerPrunerPort } from "@ecom/shared";
import { prisma } from "./db";

// A revoked row cannot be deleted immediately: reuse-detection recognises a replay by FINDING
// a revoked row, and the grace window reads its replacedAt. Only rows revoked longer ago than
// the retention window — or already expired — are safe to drop.
export const refreshTokenPrunerPort: LedgerPrunerPort = {
  async deleteOlderThan(cutoff) {
    const r = await prisma.refreshToken.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: cutoff } }],
      },
    });
    return r.count;
  },
};
