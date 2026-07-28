import {
  ORDER_PLACED,
  INVENTORY_RESERVED,
  INVENTORY_RESERVATION_FAILED,
} from "@ecom/contracts";

export type ReserveItem = { productId: string; quantity: number };

export interface ReserveTx {
  markProcessed(eventId: string, type: string): Promise<boolean>; // false => already processed
  tryDecrement(productId: string, qty: number): Promise<boolean>; // false => insufficient stock
  increment(productId: string, qty: number): Promise<void>; // compensating undo
  createReservation(orderId: string, item: ReserveItem, expiresAt: Date): Promise<void>;
  enqueue(type: string, orderId: string, payload: unknown): Promise<void>;
}

function byProductId(a: ReserveItem, b: ReserveItem): number {
  return a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0;
}

export async function reserveOrder(
  tx: ReserveTx,
  p: { eventId: string; orderId: string; items: ReserveItem[]; expiresAt: Date }
): Promise<"DUPLICATE" | "RESERVED" | "FAILED"> {
  const fresh = await tx.markProcessed(p.eventId, ORDER_PLACED);
  if (!fresh) return "DUPLICATE";

  // Deterministic order so concurrent multi-item orders can never deadlock.
  const items = [...p.items].sort(byProductId);
  const applied: ReserveItem[] = [];

  for (const item of items) {
    const ok = await tx.tryDecrement(item.productId, item.quantity);
    if (!ok) {
      // Roll back the decrements already applied in this transaction, keep the
      // ProcessedEvent row, and emit the business failure (never thrown).
      for (const done of applied) await tx.increment(done.productId, done.quantity);
      await tx.enqueue(INVENTORY_RESERVATION_FAILED, p.orderId, {
        orderId: p.orderId,
        reason: "INSUFFICIENT_STOCK",
      });
      return "FAILED";
    }
    applied.push(item);
  }

  for (const item of items) await tx.createReservation(p.orderId, item, p.expiresAt);
  await tx.enqueue(INVENTORY_RESERVED, p.orderId, { orderId: p.orderId, items });
  return "RESERVED";
}
