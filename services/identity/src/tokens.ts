import { randomBytes, createHash } from "crypto";
import jwt from "jsonwebtoken";

export type AccessClaims = { sub: string; role: string };

export interface TokenIssuer {
  signAccess(claims: AccessClaims): string;
  mintRefresh(): { token: string; tokenHash: string };
  hashRefresh(token: string): string;
}

// RS256 only: identity holds the private key, the gateway verifies with the public half.
// The refresh token is deliberately NOT a JWT — it must be revocable, and only its sha256
// is ever stored, so a database leak cannot resume sessions.
export function createTokenIssuer(cfg: {
  privateKey: string;
  accessTtl: string;
}): TokenIssuer {
  const hash = (token: string) => createHash("sha256").update(token).digest("hex");
  return {
    signAccess(claims) {
      return jwt.sign(claims, cfg.privateKey, {
        algorithm: "RS256",
        expiresIn: cfg.accessTtl as jwt.SignOptions["expiresIn"],
      });
    },
    mintRefresh() {
      const token = randomBytes(32).toString("base64url");
      return { token, tokenHash: hash(token) };
    },
    hashRefresh: hash,
  };
}
