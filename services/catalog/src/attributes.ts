import { z } from "zod";

// Transcribed from legacy/src/models/product.model.js. Each legacy sub-schema had
// exactly one required field; the rest optional. (Legacy furniture.material was a
// Number — a modeling bug; mapped to string here.)
export const ATTRIBUTE_SCHEMAS = {
  ELECTRONICS: z.object({
    manufacturer: z.string().min(1),
    model: z.string().min(1).optional(),
    color: z.string().min(1).optional(),
  }),
  CLOTHING: z.object({
    brand: z.string().min(1),
    size: z.string().min(1).optional(),
    material: z.string().min(1).optional(),
    color: z.string().min(1).optional(),
  }),
  FURNITURE: z.object({
    brand: z.string().min(1),
    size: z.string().min(1).optional(),
    material: z.string().min(1).optional(),
  }),
  MOTORBIKE: z.object({
    manufacturer: z.string().min(1),
    model: z.string().min(1).optional(),
    color: z.string().min(1).optional(),
  }),
} as const;

export type ProductType = keyof typeof ATTRIBUTE_SCHEMAS;

export function isProductType(t: string): t is ProductType {
  return t in ATTRIBUTE_SCHEMAS;
}

export function validateAttributes(
  type: string,
  attrs: unknown
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!isProductType(type)) return { ok: false, error: "unknown_type" };
  const r = ATTRIBUTE_SCHEMAS[type].safeParse(attrs);
  return r.success
    ? { ok: true, value: r.data as Record<string, unknown> }
    : { ok: false, error: "invalid_attributes" };
}
