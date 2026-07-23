import {
  INVENTORY_RESERVED,
  INVENTORY_RESERVATION_FAILED,
  ORDER_CANCELLED,
} from "@ecom/contracts";

export type OrderStatus = "PENDING" | "AWAITING_PAYMENT" | "CANCELLED" | "CONFIRMED";

// Pure transition table. Only PENDING is a live source this slice; every other
// (status, event) pair — a late, duplicate, or out-of-order event — returns null
// so the caller no-ops instead of corrupting state.
export function nextStatus(current: string, eventType: string): OrderStatus | null {
  if (current === "PENDING" && eventType === INVENTORY_RESERVED) return "AWAITING_PAYMENT";
  if (current === "PENDING" && eventType === INVENTORY_RESERVATION_FAILED) return "CANCELLED";
  return null;
}

export interface TransitionTx {
  loadOrderStatus(orderId: string): Promise<string | null>; // null => no such order
  markProcessed(eventId: string, type: string): Promise<boolean>; // false => already processed
  setStatus(orderId: string, status: OrderStatus): Promise<void>;
  enqueue(type: string, orderId: string, payload: unknown): Promise<void>;
}

export type ApplyOutcome =
  | "UNKNOWN_ORDER"
  | "DUPLICATE"
  | "NO_OP"
  | "AWAITING_PAYMENT"
  | "CANCELLED";

// Domain core over a tx-bound port (mirrors inventory/reserve.ts). Order of
// operations is load-bearing: load the order BEFORE the ledger so an unknown
// order is acked without a ProcessedEvent row and stays replay-recoverable.
export async function applyInventoryResult(
  tx: TransitionTx,
  p: { eventId: string; type: string; orderId: string }
): Promise<ApplyOutcome> {
  const status = await tx.loadOrderStatus(p.orderId);
  if (status === null) return "UNKNOWN_ORDER"; // not ledgered — replay-safe

  const fresh = await tx.markProcessed(p.eventId, p.type);
  if (!fresh) return "DUPLICATE"; // at-least-once redelivery

  const next = nextStatus(status, p.type);
  if (next === null) return "NO_OP"; // ledgered; late/out-of-order guard
  if (next !== "AWAITING_PAYMENT" && next !== "CANCELLED") {
    // Defensive: today's transition table never produces PENDING/CONFIRMED
    // here. Narrowing this way (instead of an unsafe cast) lets TypeScript
    // prove `next` fits ApplyOutcome below.
    return "NO_OP";
  }

  await tx.setStatus(p.orderId, next);
  if (next === "CANCELLED") {
    await tx.enqueue(ORDER_CANCELLED, p.orderId, { orderId: p.orderId });
  }
  return next;
}
