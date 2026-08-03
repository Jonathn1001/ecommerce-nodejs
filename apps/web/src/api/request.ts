import type { ZodType } from "zod";
import { readCsrfToken } from "./csrf";
import { refreshSession } from "./refresh";
import {
  HttpError,
  NetworkError,
  SchemaMismatchError,
  UnauthenticatedError,
} from "./errors";

export type RequestInit_ = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
};

// The only module that knows HTTP exists. Everything above it receives typed values or typed
// errors. Paths are ALWAYS same-origin under /api — Vite (dev) and nginx (prod) proxy them to
// the gateway, so no absolute URL and no gateway host ever enters the bundle. Cookies ride
// automatically: fetch defaults to same-origin credentials.
async function send(path: string, init: RequestInit_): Promise<Response> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") {
    const token = readCsrfToken();
    // The gateway compares this header against the cookie and 403s a mismatch. No cookie
    // means no session at all — a client-side fact, so say so rather than spend a round trip.
    if (!token) throw new UnauthenticatedError();
    headers["x-csrf-token"] = token;
  }
  return fetch(path, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

export async function request<T>(
  path: string,
  schema: ZodType<T>,
  init: RequestInit_ = {}
): Promise<T> {
  let res: Response;
  try {
    res = await send(path, init);
  } catch (cause) {
    if (cause instanceof UnauthenticatedError) throw cause;
    throw new NetworkError(cause);
  }

  if (res.status === 401) {
    // No XSRF cookie means there is no session to refresh. Attempting one would bounce an
    // anonymous visitor to /login on a public page and burn the auth rate limit doing it.
    if (!readCsrfToken()) throw new UnauthenticatedError();
    const refreshed = await refreshSession();
    if (!refreshed) throw new UnauthenticatedError();
    try {
      res = await send(path, init);
    } catch (cause) {
      if (cause instanceof UnauthenticatedError) throw cause;
      throw new NetworkError(cause);
    }
    // A second 401 after a successful refresh is a real failure. Never loop.
    if (res.status === 401) throw new UnauthenticatedError();
  }

  if (!res.ok) throw new HttpError(res.status);

  let body: unknown;
  try {
    body = await res.json();
  } catch (cause) {
    throw new SchemaMismatchError(path, `body was not JSON (${String(cause)})`);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new SchemaMismatchError(path, parsed.error.message);
  return parsed.data;
}
