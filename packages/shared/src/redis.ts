import { createClient, type RedisClientType } from "redis";
import { randomUUID } from "crypto";

let client: RedisClientType | null = null;
// In-flight connect() promise, shared by concurrent getRedis() callers so only
// one of them ever calls client.connect() (node-redis v4 rejects a second
// concurrent connect() on the same client). Cleared once connect() settles.
let connectPromise: Promise<void> | null = null;

export async function getRedis(): Promise<RedisClientType> {
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
    client.on("error", () => {}); // errors surface on the awaited command
  }
  if (!client.isOpen) {
    if (!connectPromise) {
      const c = client;
      connectPromise = c.connect().then(
        () => {
          connectPromise = null;
        },
        (err) => {
          connectPromise = null;
          throw err;
        }
      );
    }
    await connectPromise;
  }
  return client;
}

// Closes the shared client (if open) and resets the module singleton so a
// later getRedis() creates a fresh, connectable client. Shaped as a plain
// () => Promise<void> so it can be registered as a graceful-shutdown Closer.
export async function closeRedis(): Promise<void> {
  if (client && client.isOpen) {
    await client.quit();
  }
  client = null;
  connectPromise = null;
}

// Idempotency guard: true the first time this eventId is seen, false after.
export async function markProcessed(eventId: string, ttlSec = 86_400): Promise<boolean> {
  const c = await getRedis();
  const res = await c.set(`idem:${eventId}`, "1", { NX: true, EX: ttlSec });
  return res === "OK";
}

const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;

export async function acquireLock(
  resource: string,
  opts: { retries?: number; ttlMs?: number } = {}
): Promise<{ key: string; token: string } | null> {
  const { retries = 10, ttlMs = 3000 } = opts;
  const c = await getRedis();
  const key = `lock_v1_${resource}`;
  const token = randomUUID();
  for (let i = 0; i < retries; i++) {
    const res = await c.set(key, token, { NX: true, PX: ttlMs });
    if (res === "OK") return { key, token };
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

export async function releaseLock(handle: {
  key: string;
  token: string;
}): Promise<number> {
  const c = await getRedis();
  return (await c.eval(RELEASE_LOCK_SCRIPT, {
    keys: [handle.key],
    arguments: [handle.token],
  })) as number;
}
