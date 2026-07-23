import { createLogger, type Logger } from "@ecom/shared";
import {
  EventEnvelope,
  INVENTORY_RESERVED,
  INVENTORY_RESERVATION_FAILED,
  InventoryReservedPayloadSchema,
  InventoryReservationFailedPayloadSchema,
} from "@ecom/contracts";
import { prisma } from "./db";
import { applyInventoryResult } from "./transition";
import { transitionTx } from "./tx-adapters";

const log: Logger = createLogger("order-consumer");

export async function handleInventoryEvent(env: EventEnvelope): Promise<void> {
  let orderId: string;
  if (env.type === INVENTORY_RESERVED) {
    orderId = InventoryReservedPayloadSchema.parse(env.payload).orderId;
  } else if (env.type === INVENTORY_RESERVATION_FAILED) {
    orderId = InventoryReservationFailedPayloadSchema.parse(env.payload).orderId;
  } else {
    return; // other event types on the topic are not ours — no-op, no DLQ
  }

  const outcome = await prisma.$transaction((tx) =>
    applyInventoryResult(transitionTx(tx, env.traceId), {
      eventId: env.eventId,
      type: env.type,
      orderId,
    })
  );
  log.info("inventory_result_handled", {
    orderId,
    type: env.type,
    outcome,
    traceId: env.traceId,
  });
}
