import { z } from "zod";

// The READ API the storefront consumes, distinct from the event payloads in ../events/catalog.
// Two schemas because the two routes genuinely differ: the list omits `attributes`. Modelling
// that as one schema with an optional field would let a detail view silently render nothing
// when the field goes missing.
export const ProductTypeSchema = z.enum([
  "ELECTRONICS",
  "CLOTHING",
  "FURNITURE",
  "MOTORBIKE",
]);
export type ProductType = z.infer<typeof ProductTypeSchema>;

export const ProductListItemSchema = z.object({
  id: z.string(),
  type: ProductTypeSchema,
  name: z.string(),
  // Integer MINOR UNITS. 900 is $9.00. Divide by 100 at the presentation layer only.
  price: z.number().int(),
  version: z.number().int(),
});
export type ProductListItem = z.infer<typeof ProductListItemSchema>;

// `attributes` stays an open record: Catalog owns per-type attribute validation
// (services/catalog/src/attributes.ts), and restating it here would create a second source of
// truth to keep in sync — the exact drift these schemas exist to prevent.
export const ProductDetailSchema = ProductListItemSchema.extend({
  attributes: z.record(z.unknown()),
});
export type ProductDetail = z.infer<typeof ProductDetailSchema>;
