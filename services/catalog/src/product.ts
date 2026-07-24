import {
  CATALOG_PRODUCT_CREATED, CATALOG_PRODUCT_UPDATED, CATALOG_PRICE_CHANGED,
} from "@ecom/contracts";
import { validateAttributes } from "./attributes";

export interface ProductWriteTx {
  createProduct(data: { type: string; name: string; price: number; attributes: unknown }): Promise<{ id: string; version: number }>;
  loadForUpdate(id: string): Promise<{ type: string; name?: string; price: number } | null>;
  updateProduct(id: string, data: { name?: string; price?: number; attributes?: unknown }): Promise<{ name?: string; price: number; version: number }>;
  enqueue(type: string, productId: string, payload: unknown): Promise<void>;
}

export async function applyCreate(
  tx: ProductWriteTx,
  p: { type: string; name: string; price: number; attributes: unknown }
): Promise<{ ok: true; productId: string } | { ok: false; error: string }> {
  const attrs = validateAttributes(p.type, p.attributes);
  if (!attrs.ok) return { ok: false, error: attrs.error };
  const { id, version } = await tx.createProduct({ type: p.type, name: p.name, price: p.price, attributes: attrs.value });
  await tx.enqueue(CATALOG_PRODUCT_CREATED, id, { productId: id, name: p.name, price: p.price, version });
  return { ok: true, productId: id };
}

export async function applyUpdate(
  tx: ProductWriteTx,
  p: { id: string; name?: string; price?: number; attributes?: unknown }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const cur = await tx.loadForUpdate(p.id);
  if (cur === null) return { ok: false, error: "not_found" };
  if (p.attributes !== undefined) {
    const attrs = validateAttributes(cur.type, p.attributes);
    if (!attrs.ok) return { ok: false, error: attrs.error };
    p = { ...p, attributes: attrs.value };
  }
  const priceChanged = p.price !== undefined && p.price !== cur.price;
  const after = await tx.updateProduct(p.id, { name: p.name, price: p.price, attributes: p.attributes });
  await tx.enqueue(CATALOG_PRODUCT_UPDATED, p.id, { productId: p.id, name: after.name, price: after.price, version: after.version });
  if (priceChanged) {
    await tx.enqueue(CATALOG_PRICE_CHANGED, p.id, { productId: p.id, price: after.price, version: after.version });
  }
  return { ok: true };
}
