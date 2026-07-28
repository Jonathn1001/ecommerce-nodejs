import { describe, it, expect } from "vitest";
import { requiredPermission, absolutePath } from "../authz";
import type { Request } from "express";

const req = (baseUrl: string, path: string) => ({ baseUrl, path }) as Request;

describe("absolutePath", () => {
  it("rebuilds the absolute path from a mount (req.path is mount-relative)", () => {
    expect(absolutePath(req("/products", "/"))).toBe("/products");
    expect(absolutePath(req("/products", "/p1"))).toBe("/products/p1");
    expect(absolutePath(req("/admin/payments", "/o1/refund"))).toBe(
      "/admin/payments/o1/refund"
    );
    expect(absolutePath(req("", "/"))).toBe("/");
  });
});

describe("requiredPermission", () => {
  it("protects catalog mutations and the refund, by method", () => {
    expect(requiredPermission("POST", "/products")).toEqual({
      resource: "catalog.product",
      action: "create",
    });
    expect(requiredPermission("PATCH", "/products/p1")).toEqual({
      resource: "catalog.product",
      action: "update",
    });
    expect(requiredPermission("POST", "/admin/payments/o1/refund")).toEqual({
      resource: "payment.refund",
      action: "create",
    });
  });

  it("leaves reads and unlisted routes unprotected", () => {
    expect(requiredPermission("GET", "/products")).toBeNull();
    expect(requiredPermission("GET", "/products/p1")).toBeNull();
    expect(requiredPermission("POST", "/orders")).toBeNull(); // ownership, not a permission
    expect(requiredPermission("POST", "/cart/items")).toBeNull();
  });

  it("does not match a longer path by prefix", () => {
    expect(requiredPermission("POST", "/products/p1/comments")).toBeNull();
  });
});
