"use strict";
// Smoke test for the rewritten redis.service.js distributed lock.
// Stubs reserveInventory so no MongoDB is needed.

const assert = require("assert");

const repoPath = require.resolve(
  "../../models/repositories/inventory.repo.js"
);
let reserveResult = { modifiedCount: 1 };
require.cache[repoPath] = {
  id: repoPath,
  filename: repoPath,
  loaded: true,
  exports: { reserveInventory: async () => reserveResult },
};

const { acquireLock, releaseLock } = require(
  "../../services/redis.service.js"
);

(async () => {
  // 1. Happy path: acquire returns a {key, token} handle
  const handle = await acquireLock("smoke_p1", 2, "cart_1");
  assert.ok(handle && handle.key === "lock_v2024_smoke_p1" && handle.token, "1. acquire OK");
  console.log("1. acquire ->", handle);

  // 2. Contention: second acquire on same product fails while lock is held
  const blocked = await acquireLock("smoke_p1", 1, "cart_2", 2, 3000);
  assert.strictEqual(blocked, null, "2. contention returns null");
  console.log("2. contention -> null (correct)");

  // 3. Wrong token must NOT release the lock (ownership check)
  const wrong = await releaseLock({ key: handle.key, token: "intruder" });
  assert.strictEqual(wrong, 0, "3. wrong token releases nothing");
  console.log("3. wrong-token release -> 0 (lock kept)");

  // 4. Correct token releases exactly once
  const ok = await releaseLock(handle);
  assert.strictEqual(ok, 1, "4. owner release works");
  const again = await releaseLock(handle);
  assert.strictEqual(again, 0, "4b. second release is a no-op");
  console.log("4. owner release -> 1, repeat -> 0");

  // 5. After release the lock is acquirable again
  const handle2 = await acquireLock("smoke_p1", 1, "cart_3");
  assert.ok(handle2 && handle2.token !== handle.token, "5. re-acquire with fresh token");
  await releaseLock(handle2);
  console.log("5. re-acquire after release -> OK");

  // 6. Failed reservation (out of stock) returns null AND frees the lock immediately
  reserveResult = { modifiedCount: 0 };
  const noStock = await acquireLock("smoke_p2", 99, "cart_4");
  assert.strictEqual(noStock, null, "6. failed reservation returns null");
  reserveResult = { modifiedCount: 1 };
  const afterFail = await acquireLock("smoke_p2", 1, "cart_5", 1); // single try: only passes if lock was freed
  assert.ok(afterFail, "6b. lock was freed immediately after failed reservation");
  await releaseLock(afterFail);
  console.log("6. out-of-stock path frees lock immediately");

  // 7. TTL: lock auto-expires (acquire with 300ms TTL, no release, wait, re-acquire)
  const short = await acquireLock("smoke_p3", 1, "cart_6", 1, 300);
  assert.ok(short, "7. short-TTL acquire");
  await new Promise((r) => setTimeout(r, 400));
  const afterTtl = await acquireLock("smoke_p3", 1, "cart_7", 1);
  assert.ok(afterTtl, "7b. lock expired via TTL");
  await releaseLock(afterTtl);
  console.log("7. TTL expiry -> lock reusable");

  console.log("\nALL 7 CHECKS PASSED");
  process.exit(0);
})().catch((err) => {
  console.error("SMOKE TEST FAILED:", err.message);
  process.exit(1);
});
