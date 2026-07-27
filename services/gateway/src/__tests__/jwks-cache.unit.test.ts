import { describe, it, expect, vi } from "vitest";
import { createJwksCache } from "../jwks-cache";

const jwks = {
  keys: [{ kid: "abc", kty: "RSA", n: "x", e: "AQAB", alg: "RS256", use: "sig" }],
};

describe("createJwksCache", () => {
  it("serves a key by kid after refresh and reports unknown kids as null", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(jwks), { status: 200 })
    );
    const cache = createJwksCache({
      url: "http://identity/.well-known/jwks.json",
      ttlMs: 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await cache.refresh();
    expect(cache.ready()).toBe(true);
    expect(cache.keyFor("abc")).not.toBeNull();
    expect(cache.keyFor("nope")).toBeNull();
    cache.stop();
  });

  it("keeps the last good set when a refresh fails", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call === 1) return new Response(JSON.stringify(jwks), { status: 200 });
      return new Response("boom", { status: 500 });
    });
    const cache = createJwksCache({
      url: "http://identity",
      ttlMs: 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await cache.refresh();
    await expect(cache.refresh()).rejects.toBeTruthy();
    expect(cache.keyFor("abc")).not.toBeNull();
    cache.stop();
  });

  // Sibling of the case above, but the failure is a parse error rather than a bad HTTP
  // status: one entry in an otherwise-200 response is not a valid JWK (wrong kty for the
  // fields present), so `createPublicKey` throws mid-loop. That must reject the WHOLE
  // refresh and keep the last good set — never silently accept the entries that happened to
  // parse and drop the bad one, which would flip "reject a bad set" into "accept a partial
  // set" with nothing surfacing the difference.
  it("rejects the whole refresh when one JWK entry is malformed, keeping the last good set", async () => {
    const bad = { kid: "bad", kty: "oct", k: "not-an-rsa-or-ec-key" };
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call === 1) return new Response(JSON.stringify(jwks), { status: 200 });
      return new Response(JSON.stringify({ keys: [...jwks.keys, bad] }), { status: 200 });
    });
    const cache = createJwksCache({
      url: "http://identity",
      ttlMs: 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await cache.refresh();
    expect(cache.keyFor("abc")).not.toBeNull();
    await expect(cache.refresh()).rejects.toBeTruthy();
    expect(cache.keyFor("abc")).not.toBeNull(); // still the FIRST good set, not a partial second one
    cache.stop();
  });
});
