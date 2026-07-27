import type { LedgerPrunerPort } from "@ecom/shared";
import { prisma } from "./db";

export const ledgerPrunerPort: LedgerPrunerPort = {
  async deleteOlderThan(cutoff) {
    const r = await prisma.processedEvent.deleteMany({
      where: { processedAt: { lt: cutoff } },
    });
    return r.count;
  },
};
