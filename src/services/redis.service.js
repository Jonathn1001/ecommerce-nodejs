"use strict";

const redis = require("redis");
const crypto = require("crypto");

const { reserveInventory } = require("../models/repositories/inventory.repo");

const redisClient = redis.createClient();
redisClient.on("error", (error) => {
  console.error("Redis client error::", error);
});

// ? node-redis v4 is promise-based but requires an explicit connect()
const getRedisClient = async () => {
  if (!redisClient.isOpen) await redisClient.connect();
  return redisClient;
};

// ? Compare-and-delete must be atomic: if our TTL expired and another
// ? checkout already took the lock, a blind DEL would release THEIR lock
const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const acquireLock = async (
  product_id,
  quantity,
  cart_id,
  retryTime = 10,
  expireTime = 3000 // 3 seconds to lock
) => {
  const client = await getRedisClient();
  const key = `lock_v2024_${product_id}`;
  // ? Unique token per acquisition so we can only ever release our own lock
  const token = crypto.randomUUID();

  for (let i = 0; i < retryTime; i++) {
    // ? NX + PX in a single atomic command: the lock is born with its TTL,
    // ? so a crash right here can never leave a lock that lives forever
    const result = await client.set(key, token, { NX: true, PX: expireTime });
    if (result === "OK") {
      try {
        const isReserved = await reserveInventory({
          product_id,
          cart_id,
          quantity,
        });
        // ? If mongoDB successfully updates the inventory, then we can proceed
        if (isReserved.modifiedCount) {
          return { key, token }; // ? Lock handle, used for releasing the lock
        }
        // ? Reservation failed (e.g. out of stock): free the lock right away
        // ? instead of blocking other buyers until the TTL expires
        await releaseLock({ key, token });
        return null;
      } catch (error) {
        await releaseLock({ key, token });
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
};

const releaseLock = async ({ key, token }) => {
  const client = await getRedisClient();
  return await client.eval(RELEASE_LOCK_SCRIPT, {
    keys: [key],
    arguments: [token],
  });
};

module.exports = { acquireLock, releaseLock };
