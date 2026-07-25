import { Prisma } from "./generated/prisma";
import type { PlaceOrderTx } from "./place-order";
import type { TransitionTx } from "./transition";

// Bind a PlaceOrderTx to one Prisma interactive-transaction client. traceId is
// closured so the domain core stays free of transport concerns.
export function placeOrderTx(
  tx: Prisma.TransactionClient,
  traceId: string
): PlaceOrderTx {
  return {
    async priceOf(productId) {
      const row = await tx.catalogReadModel.findUnique({ where: { productId } });
      return row ? row.price : null;
    },
    async createOrder(o) {
      const order = await tx.order.create({
        data: {
          userId: o.userId,
          status: "PENDING",
          totalPrice: o.totalPrice,
          items: {
            create: o.items.map((i) => ({
              productId: i.productId,
              quantity: i.quantity,
              unitPrice: i.unitPrice,
            })),
          },
        },
      });
      return order.id;
    },
    async clearCart(uid) {
      await tx.cartItem.deleteMany({ where: { userId: uid } });
    },
    async enqueue(type, orderId, payload) {
      await tx.outbox.create({
        data: {
          aggregateType: "order",
          aggregateId: orderId,
          type,
          traceId,
          producer: "order",
          payload: payload as Prisma.InputJsonValue,
        },
      });
    },
  };
}

// Bind a TransitionTx to one Prisma interactive-transaction client. Mirrors
// placeOrderTx; markProcessed uses createMany+skipDuplicates for an atomic
// insert-if-absent (same idiom as inventory/tx-adapters.ts).
export function transitionTx(
  tx: Prisma.TransactionClient,
  traceId: string
): TransitionTx {
  return {
    async loadOrder(orderId) {
      const row = await tx.order.findUnique({
        where: { id: orderId },
        select: { status: true, totalPrice: true, userId: true },
      });
      return row
        ? { status: row.status, totalPrice: row.totalPrice, userId: row.userId }
        : null;
    },
    async markProcessed(eventId, type) {
      const r = await tx.processedEvent.createMany({
        data: [{ eventId, type }],
        skipDuplicates: true,
      });
      return r.count > 0;
    },
    async setStatus(orderId, status) {
      await tx.order.update({ where: { id: orderId }, data: { status } });
    },
    async enqueue(type, orderId, payload) {
      await tx.outbox.create({
        data: {
          aggregateType: "order",
          aggregateId: orderId,
          type,
          traceId,
          producer: "order",
          payload: payload as Prisma.InputJsonValue,
        },
      });
    },
    async notify(orderId, status) {
      // Bound-param tagged template (never $executeRawUnsafe). NOTIFY inside this
      // tx is delivered on COMMIT — as atomic as setStatus, dropped on rollback.
      await tx.$executeRaw`SELECT pg_notify('order_status', ${JSON.stringify({
        orderId,
        status,
      })})`;
    },
  };
}

// Catalog read-model projection. catalog.events are keyed by eventId (not
// productId), so a two-step updateMany-then-create upsert would have a
// create-side TOCTOU under concurrency — this uses one atomic conditional
// upsert instead: idempotent, out-of-order-safe (version guard), and
// concurrency-safe (single statement, no read-then-write race).
export function catalogProjectionTx(tx: Prisma.TransactionClient) {
  return {
    async apply(p: { productId: string; name: string; price: number; version: number }) {
      // Single atomic conditional upsert — idempotent, out-of-order- and concurrency-safe.
      await tx.$executeRaw`
        INSERT INTO "CatalogReadModel" ("productId", name, price, version, "updatedAt")
        VALUES (${p.productId}, ${p.name}, ${p.price}, ${p.version}, now())
        ON CONFLICT ("productId") DO UPDATE
          SET name = EXCLUDED.name, price = EXCLUDED.price,
              version = EXCLUDED.version, "updatedAt" = now()
          WHERE EXCLUDED.version > "CatalogReadModel".version`;
    },
  };
}
