import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { getRedis, markProcessed, acquireLock, releaseLock } from "../redis";

describe("redis helpers (integration — needs docker compose up)", () => {
  beforeAll(async () => {
    await getRedis();
  });
  afterAll(async () => {
    (await getRedis()).quit();
  });

  it("markProcessed returns true once, false on duplicate", async () => {
    const id = uuidv4();
    expect(await markProcessed(id)).toBe(true);
    expect(await markProcessed(id)).toBe(false);
  });

  it("acquireLock then releaseLock round-trips", async () => {
    const handle = await acquireLock(`res_${uuidv4()}`);
    expect(handle).not.toBeNull();
    expect(await releaseLock(handle!)).toBe(1);
  });

  it("acquireLock blocks a second acquire until the first is released", async () => {
    const resource = `res_${uuidv4()}`;
    const first = await acquireLock(resource, { ttlMs: 5000 });
    expect(first).not.toBeNull();

    // A rival acquirer with a single, near-immediate attempt must be shut out
    // while the first holder's lock is live.
    const rival = await acquireLock(resource, { retries: 1, ttlMs: 5000 });
    expect(rival).toBeNull();

    expect(await releaseLock(first!)).toBe(1);

    // Now that the key is gone, a fresh acquire succeeds again.
    const second = await acquireLock(resource, { ttlMs: 5000 });
    expect(second).not.toBeNull();
    expect(await releaseLock(second!)).toBe(1);
  });

  it("releaseLock only frees a lock the caller owns — a wrong token is a no-op", async () => {
    const resource = `res_${uuidv4()}`;
    const handle = await acquireLock(resource);
    expect(handle).not.toBeNull();

    const impersonator = { key: handle!.key, token: "not-the-real-token" };
    expect(await releaseLock(impersonator)).toBe(0);

    // The real lock is still held: another acquirer is still shut out.
    const rival = await acquireLock(resource, { retries: 1 });
    expect(rival).toBeNull();

    expect(await releaseLock(handle!)).toBe(1);
  });

  it("a lock expires via its TTL and can be re-acquired without an explicit release", async () => {
    const resource = `res_${uuidv4()}`;
    const first = await acquireLock(resource, { ttlMs: 150 });
    expect(first).not.toBeNull();

    // Poll (via acquireLock's own retry loop) past the 150ms TTL — no
    // releaseLock call for `first`, so this only succeeds if Redis expired
    // the key on its own.
    const second = await acquireLock(resource, { retries: 10, ttlMs: 3000 });
    expect(second).not.toBeNull();
    expect(await releaseLock(second!)).toBe(1);
  });

  it("markProcessed respects a custom ttlSec — the id is eligible again after expiry", async () => {
    const id = uuidv4();
    expect(await markProcessed(id, 1)).toBe(true);
    expect(await markProcessed(id, 1)).toBe(false);
    await new Promise((r) => setTimeout(r, 1200));
    expect(await markProcessed(id, 1)).toBe(true);
  });
});
