import { z } from "zod";

export const CATALOG_PRODUCT_CREATED = "catalog.product_created" as const;
export const CATALOG_PRODUCT_UPDATED = "catalog.product_updated" as const;
export const CATALOG_PRICE_CHANGED = "catalog.price_changed" as const;

const ProductUpsertPayload = z.object({
  productId: z.string().min(1),
  name: z.string().min(1),
  price: z.number().int().positive(),
  version: z.number().int().positive(),
});
export const ProductCreatedPayloadSchema = ProductUpsertPayload;
export const ProductUpdatedPayloadSchema = ProductUpsertPayload;
export type ProductUpsertPayload = z.infer<typeof ProductUpsertPayload>;

export const PriceChangedPayloadSchema = z.object({
  productId: z.string().min(1),
  price: z.number().int().positive(),
  version: z.number().int().positive(),
});
export type PriceChangedPayload = z.infer<typeof PriceChangedPayloadSchema>;
