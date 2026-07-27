import { createPublicKey, type JsonWebKey } from "crypto";
import { createLogger } from "@ecom/shared";

const log = createLogger("gateway-jwks");

type Jwk = JsonWebKey & { kid?: string };

export interface JwksCache {
  keyFor(kid: string | undefined): string | null;
  refresh(): Promise<void>;
  stop(): void;
  ready(): boolean;
}

// Holds { kid: PEM } so verification needs no per-request hop to identity. Boot fetch is
// fail-fast (see main.ts — an empty set would 401 every token); a failed REFRESH keeps the
// last good set, because a blip in identity must not lock everyone out. Mirrors
// grants-cache.ts's shape deliberately: same fail-fast-at-boot / keep-last-good contract.
export function createJwksCache(cfg: {
  url: string;
  ttlMs: number;
  fetchImpl?: typeof fetch;
}): JwksCache {
  const doFetch = cfg.fetchImpl ?? fetch;
  let keys: Map<string, string> = new Map();
  let loaded = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refresh(): Promise<void> {
    // Bounded: a HUNG identity (not a down one) would otherwise hang the gateway's refresh
    // loop — and, on the boot path, hang the gateway itself — forever.
    const res = await doFetch(cfg.url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`jwks_fetch_status_${res.status}`);
    const body = (await res.json()) as { keys: Jwk[] };
    const next = new Map<string, string>();
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid) continue;
      const pem = createPublicKey({ key: jwk, format: "jwk" })
        .export({ type: "spki", format: "pem" })
        .toString();
      next.set(jwk.kid, pem);
    }
    keys = next;
    loaded = true;
  }

  timer = setInterval(() => {
    refresh().catch((e) =>
      log.error("jwks_refresh_failed", { message: (e as Error).message })
    );
  }, cfg.ttlMs);
  timer.unref?.();

  return {
    keyFor: (kid) => (kid ? (keys.get(kid) ?? null) : null),
    refresh,
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    ready: () => loaded,
  };
}
