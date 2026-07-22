import { Prisma } from "./generated/prisma";
import type { PlaceOrderTx } from "./place-order";

// Bind a PlaceOrderTx to one Prisma interactive-transaction client. traceId is
// closured so the domain core stays free of transport concerns.
export function placeOrderTx(
  tx: Prisma.TransactionClient,
  userId: string,
  traceId: string
): PlaceOrderTx {
  return {
    async priceOf(productId) {
      const row = await tx.catalogReadModel.findUnique({ where: { productId } });
      return row ? row.price : null;
    },
    async createOrder(o) {
      const order = await tx.order.create({
        data: {
          userId: o.userId,
          status: "PENDING",
          totalPrice: o.totalPrice,
          items: {
            create: o.items.map((i) => ({
              productId: i.productId,
              quantity: i.quantity,
              unitPrice: i.unitPrice,
            })),
          },
        },
      });
      return order.id;
    },
    async clearCart(uid) {
      await tx.cartItem.deleteMany({ where: { userId: uid } });
    },
    async enqueue(type, orderId, payload) {
      await tx.outbox.create({
        data: {
          aggregateType: "order",
          aggregateId: orderId,
          type,
          traceId,
          producer: "order",
          payload: payload as Prisma.InputJsonValue,
        },
      });
    },
  };
}
