import { randomBytes } from "crypto";
import type { Response } from "express";

export const ACCESS_COOKIE = "access_token";
export const REFRESH_COOKIE = "refresh_token";
export const CSRF_COOKIE = "XSRF-TOKEN";

// access + refresh are httpOnly (JavaScript must never read them); XSRF-TOKEN deliberately is
// NOT, because the client has to echo it back in a header — that asymmetry is the whole
// double-submit defence. Secure is off by default so the flow works on local http.
export function setSessionCookies(
  res: Response,
  tokens: { accessToken: string; refreshToken: string },
  opts: { secure: boolean }
): void {
  const base = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: opts.secure,
    path: "/",
  };
  res.cookie(ACCESS_COOKIE, tokens.accessToken, base);
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, base);
  res.cookie(CSRF_COOKIE, randomBytes(16).toString("hex"), {
    httpOnly: false,
    sameSite: "lax",
    secure: opts.secure,
    path: "/",
  });
}

// Called on logout and on a rejected refresh: a reuse-detected client must land back at
// login rather than retrying a dead token forever.
export function clearSessionCookies(res: Response): void {
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, CSRF_COOKIE])
    res.clearCookie(name, { path: "/" });
}
