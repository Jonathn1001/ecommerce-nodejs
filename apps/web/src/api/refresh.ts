import { readCsrfToken } from "./csrf";
import { NetworkError } from "./errors";

export const API = "/api";

// Raw access to /auth/*. These paths are CSRF-exempt at the gateway except logout, carry no
// session yet, and must never enter request()'s refresh-and-retry path.
//
// The one API-layer function that touches `fetch` directly rather than going through
// request(), so it is also the one place a raw network failure (an untyped rejection) could
// leak past the error taxonomy. Wrapped in NetworkError to close that gap for the whole layer.
export async function authRequest(path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  // Logout is NOT in the gateway's CSRF exempt list; login/register/refresh are.
  const token = readCsrfToken();
  if (token) headers["x-csrf-token"] = token;
  try {
    return await fetch(`${API}${path}`, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new NetworkError(cause);
  }
}

// ONE refresh at a time. Identity rotates refresh tokens and detects reuse family-scoped, and
// /auth/* is capped at 10 requests a minute — so a page issuing parallel queries after the
// access token expires must not fire one refresh per query.
let inFlight: Promise<boolean> | null = null;

export function refreshSession(): Promise<boolean> {
  if (!inFlight) {
    inFlight = authRequest("/auth/refresh")
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}
