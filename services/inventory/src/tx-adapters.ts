import { Prisma } from "./generated/prisma";
import type { ReserveTx } from "./reserve";
import type { ReleaseTx } from "./release";
import type { ConsumeTx } from "./consume";

// Bind a ReserveTx to one Prisma interactive-transaction client. traceId is
// closured so the domain core stays free of transport concerns.
export function reserveTx(tx: Prisma.TransactionClient, traceId: string): ReserveTx {
  return {
    async markProcessed(eventId, type) {
      const r = await tx.processedEvent.createMany({
        data: [{ eventId, type }],
        skipDuplicates: true,
      });
      return r.count > 0;
    },
    async tryDecrement(productId, qty) {
      const r = await tx.inventory.updateMany({
        where: { productId, available: { gte: qty } },
        data: { available: { decrement: qty } },
      });
      return r.count > 0;
    },
    async increment(productId, qty) {
      await tx.inventory.update({
        where: { productId },
        data: { available: { increment: qty } },
      });
    },
    async createReservation(orderId, item, expiresAt) {
      await tx.reservation.create({
        data: {
          orderId,
          productId: item.productId,
          quantity: item.quantity,
          status: "ACTIVE",
          expiresAt,
        },
      });
    },
    async enqueue(type, orderId, payload) {
      await tx.outbox.create({
        data: {
          aggregateType: "inventory",
          aggregateId: orderId,
          type,
          traceId,
          producer: "inventory",
          payload: payload as Prisma.InputJsonValue,
        },
      });
    },
  };
}

export function releaseTx(tx: Prisma.TransactionClient, traceId: string): ReleaseTx {
  return {
    async markProcessed(eventId, type) {
      const r = await tx.processedEvent.createMany({
        data: [{ eventId, type }],
        skipDuplicates: true,
      });
      return r.count > 0;
    },
    async activeByOrder(orderId) {
      const rows = await tx.reservation.findMany({
        where: { orderId, status: "ACTIVE" },
        select: { id: true, productId: true, quantity: true },
      });
      return rows;
    },
    async increment(productId, qty) {
      await tx.inventory.update({
        where: { productId },
        data: { available: { increment: qty } },
      });
    },
    async markReleased(id) {
      const r = await tx.reservation.updateMany({
        where: { id, status: "ACTIVE" },
        data: { status: "RELEASED", releasedAt: new Date() },
      });
      return r.count > 0;
    },
    async enqueue(type, orderId, payload) {
      await tx.outbox.create({
        data: {
          aggregateType: "inventory",
          aggregateId: orderId,
          type,
          traceId,
          producer: "inventory",
          payload: payload as Prisma.InputJsonValue,
        },
      });
    },
  };
}

export function consumeTx(tx: Prisma.TransactionClient): ConsumeTx {
  return {
    async markProcessed(eventId, type) {
      const r = await tx.processedEvent.createMany({ data: [{ eventId, type }], skipDuplicates: true });
      return r.count > 0;
    },
    async consumeActive(orderId) {
      const r = await tx.reservation.updateMany({
        where: { orderId, status: "ACTIVE" },
        data: { status: "CONSUMED" },
      });
      return r.count;
    },
  };
}
