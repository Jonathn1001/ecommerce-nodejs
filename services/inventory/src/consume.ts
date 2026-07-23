import { ORDER_CONFIRMED } from "@ecom/contracts";

export interface ConsumeTx {
  markProcessed(eventId: string, type: string): Promise<boolean>; // false => already processed
  consumeActive(orderId: string): Promise<number>; // rows flipped ACTIVE -> CONSUMED
}

// order.confirmed -> mark this order's ACTIVE reservations CONSUMED (sweeper-immune).
// markProcessed-first (mirrors releaseForCancel). A non-ACTIVE reservation (already
// swept/released — the deferred 3c race) yields NOOP; unreachable under sync payment.
export async function consumeForConfirm(
  tx: ConsumeTx,
  p: { eventId: string; orderId: string }
): Promise<"DUPLICATE" | "CONSUMED" | "NOOP"> {
  const fresh = await tx.markProcessed(p.eventId, ORDER_CONFIRMED);
  if (!fresh) return "DUPLICATE";
  const n = await tx.consumeActive(p.orderId);
  return n > 0 ? "CONSUMED" : "NOOP";
}
