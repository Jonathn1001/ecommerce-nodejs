import { createLogger } from "@ecom/shared";

const log = createLogger("gateway-grants");

export type GrantsSnapshot = Record<string, Record<string, string[]>>;

export interface GrantsCache {
  get(): GrantsSnapshot;
  refresh(): Promise<void>;
  stop(): void;
  ready(): boolean;
}

// Holds the {role: {resource: [actions]}} map so authorization needs no per-request hop to
// identity. Boot fetch is fail-fast (an empty matrix would silently 403 everything); a failed
// REFRESH keeps the last good snapshot, because a blip in identity must not lock everyone out.
// Cost of the cache: a grant edit takes up to one TTL to bite (documented in the spec).
export function createGrantsCache(cfg: {
  identityUrl: string;
  ttlMs: number;
  fetchImpl?: typeof fetch;
}): GrantsCache {
  const doFetch = cfg.fetchImpl ?? fetch;
  let snapshot: GrantsSnapshot = {};
  let loaded = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refresh(): Promise<void> {
    // Bounded: a HUNG identity (not a down one) would otherwise hang gateway boot forever,
    // and the healthcheck would restart-loop with no useful error.
    const res = await doFetch(`${cfg.identityUrl}/internal/grants`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`grants_fetch_status_${res.status}`);
    snapshot = (await res.json()) as GrantsSnapshot;
    loaded = true;
  }

  timer = setInterval(() => {
    refresh().catch((e) =>
      log.error("grants_refresh_failed", { message: (e as Error).message })
    );
  }, cfg.ttlMs);
  timer.unref?.();

  return {
    get: () => snapshot,
    refresh,
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    ready: () => loaded,
  };
}
