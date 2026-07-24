import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { handleCatalogEvent } from "../catalog-projection";
import { prisma } from "../db";
import { makeEnvelope, CATALOG_PRODUCT_CREATED, CATALOG_PRODUCT_UPDATED, CATALOG_PRICE_CHANGED, type EventEnvelope } from "@ecom/contracts";

const ev = (type: string, payload: object): EventEnvelope => makeEnvelope({ type, version: 1, traceId: "t", producer: "catalog", payload });
const row = (id: string) => prisma.catalogReadModel.findUnique({ where: { productId: id } });

describe("order catalog projection (integration)", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("product_created inserts; higher-version update applies; lower/equal version no-ops", async () => {
    const id = `p_${randomUUID()}`;
    await handleCatalogEvent(ev(CATALOG_PRODUCT_CREATED, { productId: id, name: "A", price: 100, version: 1 }));
    expect((await row(id))!.price).toBe(100);
    await handleCatalogEvent(ev(CATALOG_PRODUCT_UPDATED, { productId: id, name: "B", price: 200, version: 2 }));
    expect((await row(id))!.price).toBe(200);
    // stale/duplicate (version 1) -> ignored
    await handleCatalogEvent(ev(CATALOG_PRODUCT_UPDATED, { productId: id, name: "OLD", price: 999, version: 1 }));
    const r = await row(id);
    expect(r!.price).toBe(200); expect(r!.version).toBe(2);
  });

  it("out-of-order: update (v2) arrives before create (v1) -> ends at v2, create no-ops", async () => {
    const id = `p_${randomUUID()}`;
    await handleCatalogEvent(ev(CATALOG_PRODUCT_UPDATED, { productId: id, name: "B", price: 200, version: 2 }));
    await handleCatalogEvent(ev(CATALOG_PRODUCT_CREATED, { productId: id, name: "A", price: 100, version: 1 }));
    const r = await row(id);
    expect(r!.price).toBe(200); expect(r!.version).toBe(2);
  });

  it("price_changed is ignored by the read model", async () => {
    const id = `p_${randomUUID()}`;
    await handleCatalogEvent(ev(CATALOG_PRODUCT_CREATED, { productId: id, name: "A", price: 100, version: 1 }));
    await handleCatalogEvent(ev(CATALOG_PRICE_CHANGED, { productId: id, price: 555, version: 2 }));
    expect((await row(id))!.price).toBe(100); // unchanged — price_changed not applied
  });
});
