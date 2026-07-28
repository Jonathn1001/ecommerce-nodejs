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
import type { SagaMetrics } from "./metrics";

const log: Logger = createLogger("order-consumer");

const NOOP_SAGA: SagaMetrics = { observeStep: () => {}, observeSaga: () => {} };
let saga: SagaMetrics = NOOP_SAGA;

// main.ts injects the real one. Default is a no-op so every existing test that imports
// handleEvent keeps working untouched.
export function setSagaMetrics(m: SagaMetrics): void {
  saga = m;
}

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

  // Advisory pre-read for the saga clock only — gates no write. Guarded: this is an
  // extra DB round-trip ahead of the real transition, so a failure here (pool
  // exhaustion, a transient timeout) must fall through to `null` rather than abort
  // the transaction below. The existing `if (before && ...)` gate already treats a
  // null pre-read as "skip recording."
  let before: { status: string; createdAt: Date; updatedAt: Date } | null = null;
  try {
    before = await prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, createdAt: true, updatedAt: true },
    });
  } catch (e) {
    log.error("saga_metrics_preread_failed", { orderId, message: (e as Error).message });
  }

  const outcome = await prisma.$transaction((tx) =>
    applyResult(transitionTx(tx, env.traceId), {
      eventId: env.eventId,
      type: env.type,
      orderId,
    })
  );

  // Only a real transition is measured. NO_OP covers the lost CAS, which emits nothing
  // and must therefore record nothing. Recording is isolated in its own try/catch —
  // same convention as the kafka handler-duration hook in @ecom/shared: a throwing
  // metric must never affect message handling, which has already committed above.
  if (
    before &&
    (outcome === "AWAITING_PAYMENT" || outcome === "CANCELLED" || outcome === "CONFIRMED")
  ) {
    try {
      const now = Date.now();
      saga.observeStep(
        before.status === "PENDING" ? "reserve" : "payment",
        (now - before.updatedAt.getTime()) / 1000
      );
      if (outcome === "CONFIRMED" || outcome === "CANCELLED") {
        saga.observeSaga(
          outcome === "CONFIRMED" ? "confirmed" : "cancelled",
          (now - before.createdAt.getTime()) / 1000
        );
      }
    } catch (e) {
      log.error("saga_metrics_record_failed", { orderId, message: (e as Error).message });
    }
  }

  log.info("saga_event_handled", {
    orderId,
    type: env.type,
    outcome,
    traceId: env.traceId,
  });
}
