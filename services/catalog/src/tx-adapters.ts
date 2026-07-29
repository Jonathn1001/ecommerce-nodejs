import { Prisma } from "./generated/prisma";
import { currentTraceparent } from "@ecom/shared";
import type { ProductWriteTx } from "./product";

export function productTx(tx: Prisma.TransactionClient, traceId: string): ProductWriteTx {
  return {
    async createProduct(data) {
      const p = await tx.product.create({
        data: {
          type: data.type,
          name: data.name,
          price: data.price,
          attributes: data.attributes as Prisma.InputJsonValue,
        },
      });
      return { id: p.id, version: p.version };
    },
    async loadForUpdate(id) {
      // Real row lock: the name says FOR UPDATE, so it must actually take one. Without it
      // two concurrent price PATCHes interleave read-read-write-write and either suppress
      // or duplicate a price_changed event. Bound param — never interpolate the id.
      const rows = await tx.$queryRaw<
        Array<{ type: string; name: string; price: number }>
      >`SELECT "type", "name", "price" FROM "Product" WHERE "id" = ${id} FOR UPDATE`;
      return rows[0] ?? null;
    },
    async updateProduct(id, data) {
      const p = await tx.product.update({
        where: { id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.price !== undefined ? { price: data.price } : {}),
          ...(data.attributes !== undefined
            ? { attributes: data.attributes as Prisma.InputJsonValue }
            : {}),
          version: { increment: 1 },
        },
        select: { name: true, price: true, version: true },
      });
      return p;
    },
    async enqueue(type, productId, payload) {
      await tx.outbox.create({
        data: {
          aggregateType: "product",
          aggregateId: productId,
          type,
          traceId,
          traceparent: currentTraceparent(),
          producer: "catalog",
          payload: payload as Prisma.InputJsonValue,
        },
      });
    },
  };
}
