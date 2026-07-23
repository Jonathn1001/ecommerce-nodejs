import { Prisma } from "./generated/prisma";
import type { ChargeTx } from "./charge";

// Bind a ChargeTx to one Prisma interactive-transaction client. markProcessed uses
// createMany+skipDuplicates (atomic insert-if-absent), same idiom as inventory/order.
export function chargeTx(tx: Prisma.TransactionClient, traceId: string): ChargeTx {
  return {
    async markProcessed(eventId, type) {
      const r = await tx.processedEvent.createMany({ data: [{ eventId, type }], skipDuplicates: true });
      return r.count > 0;
    },
    async paymentExists(orderId) {
      const row = await tx.payment.findUnique({ where: { orderId }, select: { id: true } });
      return row !== null;
    },
    async createPayment(orderId, amount, status) {
      const p = await tx.payment.create({ data: { orderId, amount, status } });
      return p.id;
    },
    async createAttempt(paymentId, outcome) {
      await tx.paymentAttempt.create({ data: { paymentId, outcome } });
    },
    async enqueue(type, orderId, payload) {
      await tx.outbox.create({
        data: {
          aggregateType: "payment",
          aggregateId: orderId,
          type,
          traceId,
          producer: "payment",
          payload: payload as Prisma.InputJsonValue,
        },
      });
    },
  };
}
