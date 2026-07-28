import type { Request, Response, NextFunction } from "express";
import { CSRF_COOKIE } from "./cookies";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Double-submit: the readable XSRF-TOKEN cookie must be echoed in X-CSRF-Token. A
// cross-site form post carries the cookie automatically but cannot read it to set the
// header, so it fails here.
//
// Exempt paths are the ones with no cookie session to abuse: the auth entry points (the
// caller has no XSRF cookie yet) and the provider webhook (a server-to-server callback).
export function csrfGuard(exempt: RegExp[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const path = (req.path || "/").replace(/\/+$/, "") || "/";
    if (!MUTATING.has(req.method) || exempt.some((r) => r.test(path))) {
      next();
      return;
    }
    const cookie = (req.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
    const header = req.header("x-csrf-token");
    if (!cookie || !header || cookie !== header) {
      res.status(403).json({ error: "csrf check failed" });
      return;
    }
    next();
  };
}
