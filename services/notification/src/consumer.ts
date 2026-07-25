import { createLogger, type Logger } from "@ecom/shared";
import {
  type EventEnvelope,
  ORDER_PLACED,
  ORDER_CONFIRMED,
  ORDER_CANCELLED,
  OrderPlacedPayloadSchema,
  OrderConfirmedPayloadSchema,
  OrderCancelledPayloadSchema,
} from "@ecom/contracts";
import { prisma } from "./db";
import { dispatchTx } from "./tx-adapters";
import { applyDispatch } from "./dispatcher";
import { config } from "./config";

const log: Logger = createLogger("notification-dispatcher");

function parse(env: EventEnvelope): { orderId: string; userId: string } | null {
  switch (env.type) {
    case ORDER_PLACED: {
      const x = OrderPlacedPayloadSchema.parse(env.payload);
      return { orderId: x.orderId, userId: x.userId };
    }
    case ORDER_CONFIRMED: {
      const x = OrderConfirmedPayloadSchema.parse(env.payload);
      return { orderId: x.orderId, userId: x.userId };
    }
    case ORDER_CANCELLED: {
      const x = OrderCancelledPayloadSchema.parse(env.payload);
      return { orderId: x.orderId, userId: x.userId };
    }
    default:
      return null;
  }
}

export async function handleOrderEvent(env: EventEnvelope): Promise<void> {
  const p = parse(env);
  if (p === null) return; // not ours
  const outcome = await prisma.$transaction((tx) =>
    applyDispatch(
      dispatchTx(tx, env.traceId),
      { eventId: env.eventId, type: env.type, orderId: p.orderId, userId: p.userId },
      config.NOTIFY_EMAIL_DOMAIN
    )
  );
  log.info("order_event_dispatched", {
    orderId: p.orderId,
    type: env.type,
    outcome,
    traceId: env.traceId,
  });
}
