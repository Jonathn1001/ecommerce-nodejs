import type { ZodType } from "zod";
import { HttpError, NetworkError, SchemaMismatchError } from "./errors";

// The only module that knows HTTP exists. Everything above it receives typed values or typed
// errors. Paths are ALWAYS same-origin — Vite (dev) and nginx (prod) proxy them to the
// gateway, so no absolute URL and no gateway host ever enters the bundle.
export async function request<T>(path: string, schema: ZodType<T>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { accept: "application/json" } });
  } catch (cause) {
    throw new NetworkError(cause);
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
