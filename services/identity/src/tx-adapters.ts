import { Prisma } from "./generated/prisma";
import type { SessionTx } from "./sessions";

export function sessionTx(tx: Prisma.TransactionClient): SessionTx {
  return {
    async findByHash(tokenHash) {
      const r = await tx.refreshToken.findUnique({ where: { tokenHash } });
      return r
        ? {
            id: r.id,
            tokenHash: r.tokenHash,
            userId: r.userId,
            familyId: r.familyId,
            revokedAt: r.revokedAt,
            replacedBy: r.replacedBy,
            expiresAt: r.expiresAt,
          }
        : null;
    },
    async revokeFamily(familyId, at) {
      await tx.refreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: at },
      });
    },
    async revokeOne(id, at) {
      await tx.refreshToken.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: at },
      });
    },
    async mintInFamily(n) {
      const row = await tx.refreshToken.create({ data: n });
      return row.id;
    },
    async linkReplacement(oldId, newId) {
      await tx.refreshToken.update({ where: { id: oldId }, data: { replacedBy: newId } });
    },
  };
}

export function outboxEnqueue(
  tx: Prisma.TransactionClient,
  traceId: string,
  type: string,
  aggregateId: string,
  payload: unknown
) {
  return tx.outbox.create({
    data: {
      aggregateType: "identity",
      aggregateId,
      type,
      traceId,
      producer: "identity",
      payload: payload as Prisma.InputJsonValue,
    },
  });
}
