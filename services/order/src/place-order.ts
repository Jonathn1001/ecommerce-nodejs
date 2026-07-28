import { ORDER_PLACED } from "@ecom/contracts";

export type PlaceItem = { productId: string; quantity: number };
export type PricedItem = { productId: string; quantity: number; unitPrice: number };

export interface PlaceOrderTx {
  priceOf(productId: string): Promise<number | null>; // null => unknown / not priced
  createOrder(o: {
    userId: string;
    items: PricedItem[];
    totalPrice: number;
  }): Promise<string>; // returns the new orderId
  clearCart(userId: string): Promise<void>;
  enqueue(type: string, orderId: string, payload: unknown): Promise<void>;
}

export async function placeOrder(
  tx: PlaceOrderTx,
  p: { userId: string; items: PlaceItem[] }
): Promise<{
  outcome: "EMPTY" | "UNPRICED" | "PLACED";
  orderId?: string;
  unpricedProductId?: string;
}> {
  if (p.items.length === 0) return { outcome: "EMPTY" };

  // Price every line first; abort before any write on a shortfall so the order
  // is never partially priced and the cart is left untouched.
  const priced: PricedItem[] = [];
  for (const item of p.items) {
    const unitPrice = await tx.priceOf(item.productId);
    if (unitPrice === null || unitPrice <= 0) {
      return { outcome: "UNPRICED", unpricedProductId: item.productId };
    }
    priced.push({ productId: item.productId, quantity: item.quantity, unitPrice });
  }

  const totalPrice = priced.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
  const orderId = await tx.createOrder({ userId: p.userId, items: priced, totalPrice });
  await tx.clearCart(p.userId);
  await tx.enqueue(ORDER_PLACED, orderId, {
    orderId,
    userId: p.userId,
    items: p.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
  });
  return { outcome: "PLACED", orderId };
}
