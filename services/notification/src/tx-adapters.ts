import { Prisma } from "./generated/prisma";
import type { DispatchTx } from "./dispatcher";

export function dispatchTx(tx: Prisma.TransactionClient, traceId: string): DispatchTx {
  return {
    async markProcessed(eventId, type) {
      const r = await tx.processedEvent.createMany({
        data: [{ eventId, type }],
        skipDuplicates: true,
      });
      return r.count > 0;
    },
    // `create` (not createMany) because the caller needs the row id for the
    // SendEmail payload; P2002 on (orderId,type) is the dedup signal, not an error.
    async createNotification(n) {
      try {
        const row = await tx.notification.create({ data: n });
        return row.id;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
          return null;
        throw e;
      }
    },
    async enqueue(type, aggregateId, payload) {
      await tx.outbox.create({
        data: {
          aggregateType: "notification",
          aggregateId,
          type,
          traceId,
          producer: "notification",
          payload: payload as Prisma.InputJsonValue,
        },
      });
    },
  };
}
