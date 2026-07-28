import { createLogger, type Logger } from "@ecom/shared";
import {
  EventEnvelope,
  INVENTORY_RESERVED,
  INVENTORY_RESERVATION_FAILED,
  PAYMENT_SUCCEEDED,
  PAYMENT_FAILED,
  InventoryReservedPayloadSchema,
  InventoryReservationFailedPayloadSchema,
  PaymentSucceededPayloadSchema,
  PaymentFailedPayloadSchema,
} from "@ecom/contracts";
import { prisma } from "./db";
import { applyResult } from "./transition";
import { transitionTx } from "./tx-adapters";

const log: Logger = createLogger("order-consumer");

// Extract orderId from any of the four saga result events; return null for
// anything else on the two topics (no-op, no DLQ).
function orderIdOf(env: EventEnvelope): string | null {
  switch (env.type) {
    case INVENTORY_RESERVED:
      return InventoryReservedPayloadSchema.parse(env.payload).orderId;
    case INVENTORY_RESERVATION_FAILED:
      return InventoryReservationFailedPayloadSchema.parse(env.payload).orderId;
    case PAYMENT_SUCCEEDED:
      return PaymentSucceededPayloadSchema.parse(env.payload).orderId;
    case PAYMENT_FAILED:
      return PaymentFailedPayloadSchema.parse(env.payload).orderId;
    default:
      return null;
  }
}

export async function handleEvent(env: EventEnvelope): Promise<void> {
  const orderId = orderIdOf(env);
  if (orderId === null) return; // not ours
  const outcome = await prisma.$transaction((tx) =>
    applyResult(transitionTx(tx, env.traceId), {
      eventId: env.eventId,
      type: env.type,
      orderId,
    })
  );
  log.info("saga_event_handled", {
    orderId,
    type: env.type,
    outcome,
    traceId: env.traceId,
  });
}
