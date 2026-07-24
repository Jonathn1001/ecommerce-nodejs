import { createLogger, type Logger } from "@ecom/shared";
import {
  EventEnvelope, CATALOG_PRODUCT_CREATED, CATALOG_PRODUCT_UPDATED,
  ProductCreatedPayloadSchema,
} from "@ecom/contracts";
import { prisma } from "./db";
import { catalogProjectionTx } from "./tx-adapters";

const log: Logger = createLogger("order-catalog-projection");

export async function handleCatalogEvent(env: EventEnvelope): Promise<void> {
  if (env.type !== CATALOG_PRODUCT_CREATED && env.type !== CATALOG_PRODUCT_UPDATED) return; // ignore price_changed + others
  const p = ProductCreatedPayloadSchema.parse(env.payload); // created/updated share the shape
  await prisma.$transaction((tx) => catalogProjectionTx(tx).apply(p));
  log.info("catalog_projected", { productId: p.productId, version: p.version, traceId: env.traceId });
}
