"use strict";

const redis = require("redis");
const redisClient = redis.createClient();
const { promisify } = require("util");

const { reserveInventory } = require("../models/repositories/inventory.repo");

const acquireLock = async (
  product_id,
  quantity,
  cart_id,
  retryTime = 10,
  expireTime = 3000 // 3 seconds to lock
) => {
  const pexpire = promisify(redisClient.pexpire).bind(redisClient);
  const setnxAsyncs = promisify(redisClient.setnx).bind(redisClient);

  const key = `lock_v2024_${product_id}`;
  for (let i = 0; i < retryTime; i++) {
    const result = await setnxAsyncs(key, expireTime);
    console.log("result::", result);
    if (lock) {
      const isReserved = await reserveInventory({
        product_id,
        cart_id,
        quantity,
      });
      // ? If mongoDB successfully updates the inventory, then we can proceed
      if (isReserved.modifiedCount) {
        await pexpire(key, expireTime);
        return key; // ? Return the key to be used for releasing the lock
      }
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const releaseLock = async (key) => {
  const delAsyncKey = promisify(redisClient.del).bind(redisClient);
  return await delAsyncKey(key);
};

module.exports = { acquireLock, releaseLock };
