import { describe, it, expect } from "vitest";
import { applyCreate, applyUpdate, type ProductWriteTx } from "../product";
import { CATALOG_PRODUCT_CREATED, CATALOG_PRODUCT_UPDATED, CATALOG_PRICE_CHANGED } from "@ecom/contracts";

function fakeTx(init?: { type?: string; price?: number; exists?: boolean }) {
  const emitted: Array<{ type: string; payload: any }> = [];
  let price = init?.price ?? 500;
  const type = init?.type ?? "ELECTRONICS";
  const exists = init?.exists ?? true;
  let version = 1;
  const tx: ProductWriteTx = {
    async createProduct() { return { id: "p1", version: 1 }; },
    async loadForUpdate() { return exists ? { type, price } : null; },
    async updateProduct(_id, data) { version += 1; if (data.price !== undefined) price = data.price; return { version, price }; },
    async enqueue(t, _p, payload) { emitted.push({ type: t, payload }); },
  };
  return { tx, emitted };
}

describe("applyCreate", () => {
  it("creates + emits product_created(version 1)", async () => {
    const f = fakeTx();
    const r = await applyCreate(f.tx, { type: "ELECTRONICS", name: "x", price: 700, attributes: { manufacturer: "Acme" } });
    expect(r).toEqual({ ok: true, productId: "p1" });
    expect(f.emitted).toEqual([{ type: CATALOG_PRODUCT_CREATED, payload: { productId: "p1", name: "x", price: 700, version: 1 } }]);
  });
  it("rejects invalid attributes without emitting", async () => {
    const f = fakeTx();
    const r = await applyCreate(f.tx, { type: "ELECTRONICS", name: "x", price: 700, attributes: {} });
    expect(r.ok).toBe(false);
    expect(f.emitted).toEqual([]);
  });
});

describe("applyUpdate", () => {
  it("price change emits product_updated AND price_changed", async () => {
    const f = fakeTx({ price: 500 });
    const r = await applyUpdate(f.tx, { id: "p1", price: 900 });
    expect(r.ok).toBe(true);
    expect(f.emitted).toEqual([
      { type: CATALOG_PRODUCT_UPDATED, payload: { productId: "p1", name: undefined, price: 900, version: 2 } },
      { type: CATALOG_PRICE_CHANGED, payload: { productId: "p1", price: 900, version: 2 } },
    ]);
  });
  it("name-only change emits product_updated ONLY (no price_changed)", async () => {
    const f = fakeTx({ price: 500 });
    await applyUpdate(f.tx, { id: "p1", name: "y" });
    expect(f.emitted.map((e) => e.type)).toEqual([CATALOG_PRODUCT_UPDATED]);
  });
  it("unknown product -> NOT_FOUND", async () => {
    const f = fakeTx({ exists: false });
    expect((await applyUpdate(f.tx, { id: "x", price: 1 })).ok).toBe(false);
  });
});
