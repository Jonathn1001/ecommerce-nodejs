export interface DiscountRule {
  kind: "PERCENT" | "FIXED"; value: number; minOrder: number; maxUses: number; maxPerUser: number; expiresAt: Date;
}
export interface DiscountCtx { orderTotal: number; totalUses: number; userUses: number; now: Date; }

// Pure. Order of checks is stable (expiry -> minOrder -> maxUses -> maxPerUser).
export function getDiscountAmount(
  d: DiscountRule, c: DiscountCtx
): { amount: number } | { ineligible: string } {
  if (c.now >= d.expiresAt) return { ineligible: "expired" };
  if (c.orderTotal < d.minOrder) return { ineligible: "min_order" };
  if (c.totalUses >= d.maxUses) return { ineligible: "max_uses" };
  if (c.userUses >= d.maxPerUser) return { ineligible: "max_per_user" };
  const raw = d.kind === "PERCENT" ? Math.floor((c.orderTotal * d.value) / 100) : d.value;
  return { amount: Math.min(raw, c.orderTotal) };
}
