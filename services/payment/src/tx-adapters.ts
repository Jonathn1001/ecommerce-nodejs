import { Prisma } from "./generated/prisma";
import type { ChargeTx } from "./charge";
import type { ResolveTx } from "./resolve";

// Bind a ChargeTx to one Prisma interactive-transaction client. markProcessed uses
// createMany+skipDuplicates (atomic insert-if-absent), same idiom as inventory/order.
export function chargeTx(tx: Prisma.TransactionClient, traceId: string): ChargeTx {
  return {
    async markProcessed(eventId, type) {
      const r = await tx.processedEvent.createMany({
        data: [{ eventId, type }],
        skipDuplicates: true,
      });
      return r.count > 0;
    },
    async paymentExists(orderId) {
      const row = await tx.payment.findUnique({
        where: { orderId },
        select: { id: true },
      });
      return row !== null;
    },
    async createPayment(orderId, amount, status, userId) {
      const p = await tx.payment.create({ data: { orderId, amount, status, userId } });
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

// Bind a ResolveTx to one Prisma interactive-transaction client. casStatus uses
// updateMany (conditional on the `from` status) so concurrent webhook deliveries
// race on the DB row: only the winner (count 1) gets to finalize + emit.
export function resolveTx(tx: Prisma.TransactionClient, traceId: string): ResolveTx {
  return {
    async loadPayment(orderId) {
      const row = await tx.payment.findUnique({
        where: { orderId },
        select: { id: true, status: true, amount: true },
      });
      return row ? { paymentId: row.id, status: row.status, amount: row.amount } : null;
    },
    async casStatus(orderId, from, to) {
      const r = await tx.payment.updateMany({
        where: { orderId, status: from },
        data: { status: to },
      });
      return r.count;
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
