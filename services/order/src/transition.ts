import {
  INVENTORY_RESERVED,
  INVENTORY_RESERVATION_FAILED,
  ORDER_CANCELLED,
  ORDER_CONFIRMED,
  CHARGE_PAYMENT,
  PAYMENT_SUCCEEDED,
  PAYMENT_FAILED,
} from "@ecom/contracts";

export type OrderStatus = "PENDING" | "AWAITING_PAYMENT" | "CANCELLED" | "CONFIRMED";

// Pure transition table. Widened for the payment leg (3b).
export function nextStatus(
  current: string,
  eventType: string
): "AWAITING_PAYMENT" | "CANCELLED" | "CONFIRMED" | null {
  if (current === "PENDING" && eventType === INVENTORY_RESERVED)
    return "AWAITING_PAYMENT";
  if (current === "PENDING" && eventType === INVENTORY_RESERVATION_FAILED)
    return "CANCELLED";
  if (current === "AWAITING_PAYMENT" && eventType === PAYMENT_SUCCEEDED)
    return "CONFIRMED";
  if (current === "AWAITING_PAYMENT" && eventType === PAYMENT_FAILED) return "CANCELLED";
  return null;
}

export interface TransitionTx {
  loadOrder(
    orderId: string
  ): Promise<{ status: string; totalPrice: number; userId: string } | null>;
  markProcessed(eventId: string, type: string): Promise<boolean>;
  setStatus(orderId: string, status: OrderStatus): Promise<void>;
  enqueue(type: string, orderId: string, payload: unknown): Promise<void>;
  notify(orderId: string, status: OrderStatus): Promise<void>;
}

export type ApplyOutcome =
  | "UNKNOWN_ORDER"
  | "DUPLICATE"
  | "NO_OP"
  | "AWAITING_PAYMENT"
  | "CANCELLED"
  | "CONFIRMED";

// Domain core over a tx port. Load-before-ledger (unknown order acked without a
// ProcessedEvent row → replay-safe). Covers inventory + payment events.
export async function applyResult(
  tx: TransitionTx,
  p: { eventId: string; type: string; orderId: string }
): Promise<ApplyOutcome> {
  const order = await tx.loadOrder(p.orderId);
  if (order === null) return "UNKNOWN_ORDER";

  const fresh = await tx.markProcessed(p.eventId, p.type);
  if (!fresh) return "DUPLICATE";

  const next = nextStatus(order.status, p.type);
  if (next === null) return "NO_OP";

  await tx.setStatus(p.orderId, next);
  await tx.notify(p.orderId, next); // SSE: pg_notify on commit (Task 6/7 fan-out)
  if (next === "AWAITING_PAYMENT") {
    // Atomic command emission: the ChargePayment outbox row commits with the
    // status change; the relay routes it to RabbitMQ payment.charge.
    await tx.enqueue(CHARGE_PAYMENT, p.orderId, {
      orderId: p.orderId,
      amount: order.totalPrice,
    });
  } else if (next === "CONFIRMED") {
    await tx.enqueue(ORDER_CONFIRMED, p.orderId, {
      orderId: p.orderId,
      userId: order.userId,
    });
  } else if (next === "CANCELLED") {
    await tx.enqueue(ORDER_CANCELLED, p.orderId, {
      orderId: p.orderId,
      userId: order.userId,
    });
  }
  return next;
}
