import type { LedgerPrunerPort } from "@ecom/shared";
import { prisma } from "./db";

// A revoked row cannot be deleted immediately: reuse-detection recognises a replay by FINDING
// a revoked row, and the grace window reads its replacedAt. Only rows revoked longer ago than
// the retention window are safe to drop on that arm — which is why the expiry arm below is
// scoped to `revokedAt: null` rather than deleting on expiry alone: a row can be both revoked
// and expired (logout() on an already-expired token sets revokedAt with no expiry filter), and
// expired must never override revoked.
export const refreshTokenPrunerPort: LedgerPrunerPort = {
  async deleteOlderThan(cutoff) {
    const r = await prisma.refreshToken.deleteMany({
      where: {
        OR: [
          { revokedAt: null, expiresAt: { lt: new Date() } }, // never revoked, just aged out
          { revokedAt: { lt: cutoff } }, // revoked, and past the window
        ],
      },
    });
    return r.count;
  },
};
