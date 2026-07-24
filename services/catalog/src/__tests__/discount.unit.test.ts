import { describe, it, expect } from "vitest";
import { getDiscountAmount } from "../discount";

const base = { kind: "PERCENT" as const, value: 10, minOrder: 100, maxUses: 5, maxPerUser: 1, expiresAt: new Date("2030-01-01") };
const ctx = { orderTotal: 1000, totalUses: 0, userUses: 0, now: new Date("2026-01-01") };

describe("getDiscountAmount", () => {
  it("PERCENT 10% of 1000 = 100", () => { expect(getDiscountAmount(base, ctx)).toEqual({ amount: 100 }); });
  it("FIXED capped at orderTotal", () => { expect(getDiscountAmount({ ...base, kind: "FIXED", value: 5000 }, { ...ctx, orderTotal: 300 })).toEqual({ amount: 300 }); });
  it("expired -> ineligible", () => { expect(getDiscountAmount({ ...base, expiresAt: new Date("2020-01-01") }, ctx)).toEqual({ ineligible: "expired" }); });
  it("below minOrder -> ineligible", () => { expect(getDiscountAmount(base, { ...ctx, orderTotal: 50 })).toEqual({ ineligible: "min_order" }); });
  it("maxUses reached -> ineligible", () => { expect(getDiscountAmount(base, { ...ctx, totalUses: 5 })).toEqual({ ineligible: "max_uses" }); });
  it("maxPerUser reached -> ineligible", () => { expect(getDiscountAmount(base, { ...ctx, userUses: 1 })).toEqual({ ineligible: "max_per_user" }); });
});
