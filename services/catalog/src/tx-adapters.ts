import { Prisma } from "./generated/prisma";
import type { ProductWriteTx } from "./product";

export function productTx(tx: Prisma.TransactionClient, traceId: string): ProductWriteTx {
  return {
    async createProduct(data) {
      const p = await tx.product.create({
        data: { type: data.type, name: data.name, price: data.price, attributes: data.attributes as Prisma.InputJsonValue },
      });
      return { id: p.id, version: p.version };
    },
    async loadForUpdate(id) {
      const p = await tx.product.findUnique({ where: { id }, select: { type: true, name: true, price: true } });
      return p ?? null;
    },
    async updateProduct(id, data) {
      const p = await tx.product.update({
        where: { id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.price !== undefined ? { price: data.price } : {}),
          ...(data.attributes !== undefined ? { attributes: data.attributes as Prisma.InputJsonValue } : {}),
          version: { increment: 1 },
        },
        select: { name: true, price: true, version: true },
      });
      return p;
    },
    async enqueue(type, productId, payload) {
      await tx.outbox.create({
        data: { aggregateType: "product", aggregateId: productId, type, traceId, producer: "catalog", payload: payload as Prisma.InputJsonValue },
      });
    },
  };
}
