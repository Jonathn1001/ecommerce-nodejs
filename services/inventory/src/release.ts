import { ORDER_CANCELLED, INVENTORY_RELEASED } from "@ecom/contracts";

export type ReleasableRow = { id: string; productId: string; quantity: number };

export interface ReleaseCoreTx {
  increment(productId: string, qty: number): Promise<void>;
  markReleased(reservationId: string): Promise<void>;
  enqueue(type: string, orderId: string, payload: unknown): Promise<void>;
}

export interface ReleaseTx extends ReleaseCoreTx {
  markProcessed(eventId: string, type: string): Promise<boolean>;
  activeByOrder(orderId: string): Promise<ReleasableRow[]>;
}

// Shared primitive: give back stock and mark each row RELEASED. Emits exactly one
// InventoryReleased when something was released; NOOP (no emit) for an empty set.
export async function releaseRows(
  tx: ReleaseCoreTx,
  orderId: string,
  rows: ReleasableRow[]
): Promise<"RELEASED" | "NOOP"> {
  if (rows.length === 0) return "NOOP";
  for (const r of rows) {
    await tx.increment(r.productId, r.quantity);
    await tx.markReleased(r.id);
  }
  await tx.enqueue(INVENTORY_RELEASED, orderId, {
    orderId,
    items: rows.map((r) => ({ productId: r.productId, quantity: r.quantity })),
  });
  return "RELEASED";
}

export async function releaseForCancel(
  tx: ReleaseTx,
  p: { eventId: string; orderId: string }
): Promise<"DUPLICATE" | "RELEASED" | "NOOP"> {
  const fresh = await tx.markProcessed(p.eventId, ORDER_CANCELLED);
  if (!fresh) return "DUPLICATE";
  const rows = await tx.activeByOrder(p.orderId);
  return releaseRows(tx, p.orderId, rows);
}
