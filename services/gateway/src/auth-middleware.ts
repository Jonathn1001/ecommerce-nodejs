import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export const USER_HEADER = "x-user-id";
export const ROLE_HEADER = "x-user-role";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      caller?: { userId: string; role: string };
    }
  }
}

// Runs FIRST on every request, authenticated or not: a client must never be able to hand a
// service an identity by guessing a header name. Stripping unconditionally is what makes the
// gateway-injects-identity model safe.
export function stripIdentityHeaders() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    delete req.headers[USER_HEADER];
    delete req.headers[ROLE_HEADER];
    next();
  };
}

// Verifies the RS256 access token (cookie first, then Authorization: Bearer) and injects the
// verified identity for downstream services. `required: false` lets public routes through
// while still honouring a valid token if one is present.
//
// `resolveKey` picks WHICH key to try, by `kid` — it never picks the algorithm. That stays
// hardcoded to RS256 below, so a forged/decoded header can never downgrade verification. An
// unresolved kid (unknown, or missing with no fallback key configured) is treated exactly
// like a bad signature: try the next candidate, then 401 — never "try every key" and never
// let the request through unauthenticated just because no key matched.
export function authenticate(
  resolveKey: (kid: string | undefined) => string | null,
  opts: { required: boolean }
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const fromCookie = (req.cookies as Record<string, string> | undefined)?.access_token;
    const header = req.header("authorization");
    const fromHeader = header?.startsWith("Bearer ") ? header.slice(7) : null;
    // Try both, cookie first: a stale cookie must not make a valid Bearer unusable.
    const candidates = [fromCookie, fromHeader].filter((t): t is string => !!t);

    if (candidates.length === 0) {
      if (opts.required) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }
      next();
      return;
    }

    for (const token of candidates) {
      // Decoding just reads the header to pick a key; it is never trusted for anything else
      // (claims are only accepted once `jwt.verify` below has checked the signature).
      const decoded = jwt.decode(token, { complete: true }) as {
        header: { kid?: string };
      } | null;
      const key = resolveKey(decoded?.header?.kid);
      if (!key) continue; // unknown or missing kid: no key to verify against, try the next candidate

      try {
        const claims = jwt.verify(token, key, { algorithms: ["RS256"] }) as {
          sub?: string;
          role?: string;
        };
        if (!claims.sub || !claims.role) continue;
        req.caller = { userId: claims.sub, role: claims.role };
        req.headers[USER_HEADER] = claims.sub;
        req.headers[ROLE_HEADER] = claims.role;
        next();
        return;
      } catch {
        // Expired or forged — try the next candidate, then fail identically either way.
      }
    }
    res.status(401).json({ error: "unauthenticated" });
  };
}
