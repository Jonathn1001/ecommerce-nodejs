import { describe, it, expect, vi } from "vitest";
import { createJwksCache } from "../jwks-cache";

const jwks = { keys: [{ kid: "abc", kty: "RSA", n: "x", e: "AQAB", alg: "RS256", use: "sig" }] };

describe("createJwksCache", () => {
  it("serves a key by kid after refresh and reports unknown kids as null", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 }));
    const cache = createJwksCache({ url: "http://identity/.well-known/jwks.json", ttlMs: 60_000, fetchImpl: fetchImpl as unknown as typeof fetch });
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
    const cache = createJwksCache({ url: "http://identity", ttlMs: 60_000, fetchImpl: fetchImpl as unknown as typeof fetch });
    await cache.refresh();
    await expect(cache.refresh()).rejects.toBeTruthy();
    expect(cache.keyFor("abc")).not.toBeNull();
    cache.stop();
  });
});
