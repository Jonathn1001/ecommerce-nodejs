import { acquireLock, releaseLock, createLogger, type Logger } from "@ecom/shared";
import {
  EventEnvelope,
  ORDER_PLACED,
  ORDER_CANCELLED,
  OrderPlacedPayloadSchema,
  OrderCancelledPayloadSchema,
} from "@ecom/contracts";
import { prisma } from "./db";
import { config } from "./config";
import { reserveOrder } from "./reserve";
import { releaseForCancel } from "./release";
import { reserveTx, releaseTx } from "./tx-adapters";

const log: Logger = createLogger("inventory-consumer");

export async function handleOrderEvent(env: EventEnvelope): Promise<void> {
  if (env.type === ORDER_PLACED) return handlePlaced(env);
  if (env.type === ORDER_CANCELLED) return handleCancelled(env);
  // Other event types on the topic are not ours — ignore (no-op, no DLQ).
}

async function handlePlaced(env: EventEnvelope): Promise<void> {
  const payload = OrderPlacedPayloadSchema.parse(env.payload);
  const products = [...new Set(payload.items.map((i) => i.productId))].sort();
  const held: Array<{ key: string; token: string }> = [];
  try {
    // Distributed-lock lesson: lock every product, in sorted order (deadlock-free).
    // The SQL guard is the real correctness boundary, so degrade rather than DLQ.
    for (const productId of products) {
      const handle = await acquireLock(productId);
      if (handle) held.push(handle);
      else log.warn("lock_contention_degraded", { productId, traceId: env.traceId });
    }

    const outcome = await prisma.$transaction((tx) =>
      reserveOrder(reserveTx(tx, env.traceId), {
        eventId: env.eventId,
        orderId: payload.orderId,
        items: payload.items,
        expiresAt: new Date(Date.now() + config.RESERVATION_TTL_MS),
      })
    );
    log.info("order_placed_handled", {
      orderId: payload.orderId,
      outcome,
      traceId: env.traceId,
    });
  } finally {
    for (const handle of held) await releaseLock(handle);
  }
}

async function handleCancelled(env: EventEnvelope): Promise<void> {
  const payload = OrderCancelledPayloadSchema.parse(env.payload);
  const outcome = await prisma.$transaction((tx) =>
    releaseForCancel(releaseTx(tx, env.traceId), {
      eventId: env.eventId,
      orderId: payload.orderId,
    })
  );
  log.info("order_cancelled_handled", {
    orderId: payload.orderId,
    outcome,
    traceId: env.traceId,
  });
}
