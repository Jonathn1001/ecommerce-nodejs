import type { Request, Response, NextFunction } from "express";
import { createLogger } from "@ecom/shared";
import type { GrantsCache } from "./grants-cache";

const log = createLogger("gateway-authz");

export type Permission = { resource: string; action: string };
export type Rule = { method: string; pattern: RegExp; permission: Permission };

// Explicit list, not a framework: a route is protected only if it appears here. Everything
// else needs authentication only, and ownership stays in the owning service (the gateway has
// no domain data to check rows against). Paths are the services' REAL paths — the proxy does
// not rewrite prefixes.
export const RULES: Rule[] = [
  {
    method: "POST",
    pattern: /^\/products\/?$/,
    permission: { resource: "catalog.product", action: "create" },
  },
  {
    method: "PATCH",
    pattern: /^\/products\/[^/]+\/?$/,
    permission: { resource: "catalog.product", action: "update" },
  },
  {
    method: "POST",
    pattern: /^\/discounts\/?$/,
    permission: { resource: "catalog.discount", action: "create" },
  },
  {
    method: "POST",
    pattern: /^\/admin\/payments\/[^/]+\/refund\/?$/,
    permission: { resource: "payment.refund", action: "create" },
  },
];

export function requiredPermission(method: string, path: string): Permission | null {
  const hit = RULES.find((r) => r.method === method && r.pattern.test(path));
  return hit ? hit.permission : null;
}

// Inside an `app.use("/products", ...)` mount, `req.path` is mount-RELATIVE ("/"), so
// matching on it alone would silently let every protected mutation through. Rebuild the
// absolute path from baseUrl + path.
export function absolutePath(req: Request): string {
  const joined = `${req.baseUrl ?? ""}${req.path ?? ""}`;
  return joined.replace(/\/+$/, "") || "/";
}

export function authorize(grants: GrantsCache) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const needed = requiredPermission(req.method, absolutePath(req));
    if (!needed) {
      next();
      return;
    }
    const role = req.caller?.role;
    if (!role) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const allowed =
      grants.get()[role]?.[needed.resource]?.includes(needed.action) ?? false;
    if (!allowed) {
      log.info("authz_denied", {
        role,
        resource: needed.resource,
        action: needed.action,
        traceId: req.traceId,
      });
      res.status(403).json({ error: "forbidden" });
      return;
    }
    next();
  };
}
