import { describe, it, expect } from "vitest";
import {
  CATALOG_PRODUCT_CREATED,
  CATALOG_PRODUCT_UPDATED,
  CATALOG_PRICE_CHANGED,
  ProductCreatedPayloadSchema,
  PriceChangedPayloadSchema,
} from "../events/catalog";

describe("catalog contracts", () => {
  it("type strings", () => {
    expect(CATALOG_PRODUCT_CREATED).toBe("catalog.product_created");
    expect(CATALOG_PRODUCT_UPDATED).toBe("catalog.product_updated");
    expect(CATALOG_PRICE_CHANGED).toBe("catalog.price_changed");
  });
  it("product payload validates {productId,name,price,version}", () => {
    expect(
      ProductCreatedPayloadSchema.parse({
        productId: "p1",
        name: "x",
        price: 500,
        version: 1,
      })
    ).toEqual({ productId: "p1", name: "x", price: 500, version: 1 });
    expect(
      ProductCreatedPayloadSchema.safeParse({
        productId: "p1",
        name: "x",
        price: 0,
        version: 1,
      }).success
    ).toBe(false);
    expect(
      ProductCreatedPayloadSchema.safeParse({
        productId: "p1",
        name: "x",
        price: 500,
        version: 0,
      }).success
    ).toBe(false);
  });
  it("price_changed payload validates {productId,price,version}", () => {
    expect(
      PriceChangedPayloadSchema.parse({ productId: "p1", price: 500, version: 2 })
    ).toEqual({ productId: "p1", price: 500, version: 2 });
    expect(
      PriceChangedPayloadSchema.safeParse({ productId: "p1", price: 500 }).success
    ).toBe(false);
  });
});
