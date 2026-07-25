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
export function authenticate(publicKey: string, opts: { required: boolean }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const fromCookie = (req.cookies as Record<string, string> | undefined)?.access_token;
    const header = req.header("authorization");
    const token = fromCookie ?? (header?.startsWith("Bearer ") ? header.slice(7) : null);

    if (!token) {
      if (opts.required) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }
      next();
      return;
    }

    try {
      const claims = jwt.verify(token, publicKey, { algorithms: ["RS256"] }) as {
        sub?: string;
        role?: string;
      };
      if (!claims.sub || !claims.role) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }
      req.caller = { userId: claims.sub, role: claims.role };
      req.headers[USER_HEADER] = claims.sub;
      req.headers[ROLE_HEADER] = claims.role;
      next();
    } catch {
      // Expired or forged — identical answer either way.
      res.status(401).json({ error: "unauthenticated" });
    }
  };
}
