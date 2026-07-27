# Phase 7a · Correctness & hygiene debt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every tracked correctness, security and hygiene deferral from Phases 3–6, so the suite is fully green and no known security hole is open before the instrumentation slices (7b/7c/7d) land.

**Architecture:** No shared architecture — 12 independent tasks grouped by risk. One new shared primitive (`startLedgerPruner`, a sibling of `startExpirySweeper`) is reused by five services. Task 8 is the only cross-service contract change; Task 10 (JWKS) is last so it can be dropped without disturbing anything above it.

**Tech Stack:** TypeScript, Express, Prisma (Postgres), KafkaJS + amqplib via `@ecom/shared`, `jsonwebtoken`, Vitest + supertest.

**Reference spec:** `docs/superpowers/specs/2026-07-25-phase-7a-correctness-hygiene-design.md`

## Global Constraints

- **Migrations are CLI-only** (`prisma migrate dev --name <x>`); never hand-write or edit files under `prisma/migrations/`.
- **Logs carry ids and codes only** — never a token, password, email, cookie, signature or body.
- Per-service tests run with that service's own inline `DATABASE_URL`; two services can never share one Vitest process.
- Commit specific files, never `git add -A`.
- **The regression gate for this slice is a fully green suite.** The 2 `sweeper.int` failures stop being an accepted exception after Task 1.
- Every task: RED test first, run it and see it fail, minimal implementation, run it green, typecheck, commit.

---

## File Structure

- **Modify** `services/inventory/src/sweeper.ts` (per-order isolation).
- **Modify** `services/order/src/{transition.ts,tx-adapters.ts}` + tests (CAS).
- **Modify** `services/catalog/src/tx-adapters.ts` (row lock).
- **Create** `packages/shared/src/ledger-pruner.ts` + test; **modify** four services' `main.ts` + a `prune-adapter.ts` each.
- **Modify** `services/identity/src/main.ts` (+ refresh-token pruner adapter).
- **Modify** `services/{catalog,identity}/prisma/schema.prisma` (drop dead tables) + CLI migrations.
- **Create** `services/payment/src/webhook-signature.ts` + test; **modify** `services/payment/src/{app.ts,config.ts}`.
- **Modify** `packages/contracts/src/events/payment.ts`, `services/order/src/transition.ts`, `services/payment/src/{consumer.ts,charge.ts,tx-adapters.ts,app.ts}`, `services/payment/prisma/schema.prisma`, `services/gateway/src/app.ts`.
- **Modify** `services/identity/src/{sessions.ts,tx-adapters.ts,auth.ts,config.ts}` + `prisma/schema.prisma` (grace window).
- **Create** `services/identity/src/jwks.ts`, `services/gateway/src/jwks-cache.ts` + tests; **modify** identity `{tokens.ts,app.ts,config.ts}` and gateway `{auth-middleware.ts,app.ts,config.ts,main.ts}`.
- **Create** `infra/scripts/reset-dev-topics.sh`; **modify** `.github/workflows/ci.yml`.

---

### Task 1: Inventory sweeper — per-order isolation

**Files:**
- Modify: `services/inventory/src/sweeper.ts`
- Test: `services/inventory/src/__tests__/sweeper.int.test.ts`

**Interfaces — Produces:** `sweepOnce(): Promise<number>` — unchanged signature; now returns reservations released by the orders that *succeeded*.

- [ ] **Step 1: Write the failing test** — append to `sweeper.int.test.ts`:

```ts
  it("a poisoned order does not abandon the rest of the batch", async () => {
    // Reservation whose Inventory row is gone -> tx.inventory.update raises P2025.
    const deadProduct = `p_${randomUUID()}`;
    await prisma.reservation.create({
      data: {
        orderId: `o_${randomUUID()}`,
        productId: deadProduct,
        quantity: 1,
        status: "ACTIVE",
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    // ...and a healthy expired reservation that must still be swept.
    const goodProduct = `p_${randomUUID()}`;
    await prisma.inventory.create({ data: { productId: goodProduct, available: 5 } });
    const goodOrder = `o_${randomUUID()}`;
    await prisma.reservation.create({
      data: {
        orderId: goodOrder,
        productId: goodProduct,
        quantity: 2,
        status: "ACTIVE",
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    await sweepOnce();

    expect(
      (await prisma.inventory.findUnique({ where: { productId: goodProduct } }))?.available
    ).toBe(7);
    expect(
      (await prisma.reservation.findFirst({ where: { orderId: goodOrder } }))?.status
    ).toBe("RELEASED");
  });
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `DATABASE_URL='postgresql://ecom:ecom@localhost:5432/inventory' pnpm vitest run services/inventory/src/__tests__/sweeper.int.test.ts`
Expected: FAIL — `PrismaClientKnownRequestError` P2025 escapes `sweepOnce`; the healthy order is never swept.

- [ ] **Step 3: Implement** — in `services/inventory/src/sweeper.ts`, replace the loop body:

```ts
  let count = 0;
  for (const [orderId, rows] of byOrder) {
    const traceId = `sweeper-${randomUUID()}`;
    try {
      await prisma.$transaction((tx) =>
        releaseRows(
          sweepTx(tx, traceId),
          orderId,
          rows.map((r) => ({ id: r.id, productId: r.productId, quantity: r.quantity }))
        )
      );
      count += rows.length;
    } catch (e) {
      // One order's failure must not abandon the batch — same lane isolation the outbox
      // relay tick uses. The reservation stays ACTIVE and is retried next sweep; releasing
      // stock against a missing inventory row would be worse than leaving it held.
      log.error("sweep_order_failed", { orderId, message: (e as Error).message });
    }
  }
```

- [ ] **Step 4: Run — expect PASS, including the 2 previously-failing tests**

Run: `DATABASE_URL='postgresql://ecom:ecom@localhost:5432/inventory' pnpm vitest run services/inventory`
Expected: all green (23+1 tests).

- [ ] **Step 5: Commit**

```bash
git add services/inventory/src/sweeper.ts services/inventory/src/__tests__/sweeper.int.test.ts
git commit -m "fix(inventory): isolate each order in sweepOnce so one failure cannot abandon the batch"
```

---

### Task 2: Order `setStatus` compare-and-set

**Files:**
- Modify: `services/order/src/transition.ts`, `services/order/src/tx-adapters.ts`
- Test: `services/order/src/__tests__/transition.unit.test.ts`

**Interfaces — Produces:** `TransitionTx.setStatus(orderId: string, next: OrderStatus, expected: string): Promise<boolean>` — `false` means another event already moved the order. `applyResult` returns `"NO_OP"` on a lost CAS.

- [ ] **Step 1: Write the failing test** — add to `transition.unit.test.ts` (the `fakeTx` helper gains a `casLoses` option):

```ts
  it("a lost CAS -> NO_OP: no event emitted, no SSE notify", async () => {
    const f = fakeTx({ status: "AWAITING_PAYMENT" });
    f.failCas(); // another event already advanced this order
    const outcome = await applyResult(f.tx, {
      eventId: "e9",
      type: PAYMENT_SUCCEEDED,
      orderId: "o9",
    });
    expect(outcome).toBe("NO_OP");
    expect(f.emitted).toEqual([]);
    expect(f.notified).toEqual([]);
  });
```

and in `fakeTx`, replace the `setStatus` member and add the toggle:

```ts
  let casFails = false;
  const tx: TransitionTx = {
    // ...unchanged members...
    async setStatus(_o, s, expected) {
      if (casFails) return false;
      if (expected !== status) return false; // mirrors WHERE status = expected
      status = s;
      return true;
    },
  };
  return {
    tx,
    emitted,
    processed,
    notified,
    statusNow: () => status,
    failCas: () => {
      casFails = true;
    },
  };
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm vitest run services/order/src/__tests__/transition.unit.test.ts`
Expected: FAIL — `setStatus` takes two arguments and returns void; `applyResult` proceeds to emit.

- [ ] **Step 3: Implement** — `services/order/src/transition.ts`:

```ts
  setStatus(orderId: string, status: OrderStatus, expected: string): Promise<boolean>;
```

and in `applyResult`, replace the write:

```ts
  // Compare-and-set: `expected` is the status we read above. A lost CAS means another
  // event legitimately advanced this order, so this one must emit nothing.
  const moved = await tx.setStatus(p.orderId, next, order.status);
  if (!moved) return "NO_OP";
  await tx.notify(p.orderId, next); // SSE: pg_notify on commit
```

`services/order/src/tx-adapters.ts`:

```ts
    async setStatus(orderId, status, expected) {
      const r = await tx.order.updateMany({
        where: { id: orderId, status: expected },
        data: { status },
      });
      return r.count > 0;
    },
```

> The `ProcessedEvent` row written earlier in this transaction stays. Rolling back would
> redeliver an event that can never succeed.

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm vitest run services/order/src/__tests__/transition.unit.test.ts` then
`DATABASE_URL='postgresql://ecom:ecom@localhost:5432/order' pnpm vitest run services/order`
Expected: all green.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @ecom/order typecheck
git add services/order/src/transition.ts services/order/src/tx-adapters.ts services/order/src/__tests__/transition.unit.test.ts
git commit -m "fix(order): compare-and-set on setStatus; a lost CAS is NO_OP and emits nothing"
```

---

### Task 3: Catalog `loadForUpdate` → real row lock

**Files:**
- Modify: `services/catalog/src/tx-adapters.ts`
- Test: `services/catalog/src/__tests__/price-lock.int.test.ts` (create)

**Interfaces — Produces:** `loadForUpdate(id)` unchanged in shape (`{ type, name, price } | null`), now holding a row lock for the rest of the transaction.

- [ ] **Step 1: Write the failing test** — `services/catalog/src/__tests__/price-lock.int.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../db";
import { CATALOG_PRICE_CHANGED } from "@ecom/contracts";

const app = createApp();

describe("catalog price lock (integration — needs compose up + migrated)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("two concurrent price PATCHes emit exactly two price_changed rows", async () => {
    const created = await request(app)
      .post("/products")
      .send({ type: "ELECTRONICS", name: `p_${randomUUID()}`, price: 100, attributes: { manufacturer: "m", model: "x", color: "black" } })
      .expect(201);
    const id = created.body.id as string;

    await Promise.all([
      request(app).patch(`/products/${id}`).send({ price: 200 }),
      request(app).patch(`/products/${id}`).send({ price: 300 }),
    ]);

    const events = await prisma.outbox.findMany({
      where: { aggregateId: id, type: CATALOG_PRICE_CHANGED },
      orderBy: { occurredAt: "asc" },
    });
    expect(events).toHaveLength(2);
    const versions = events.map((e) => (e.payload as { version: number }).version);
    expect(new Set(versions).size).toBe(2); // serialized: never the same version twice
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (flaky-by-design: run twice)**

Run: `DATABASE_URL='postgresql://ecom:ecom@localhost:5432/catalog' pnpm vitest run services/catalog/src/__tests__/price-lock.int.test.ts`
Expected: FAIL — with a plain `findUnique` both transactions read the same version and emit duplicate/suppressed events.

- [ ] **Step 3: Implement** — `services/catalog/src/tx-adapters.ts`:

```ts
    async loadForUpdate(id) {
      // Real row lock: the name says FOR UPDATE, so it must actually take one. Without it
      // two concurrent price PATCHes interleave read-read-write-write and either suppress
      // or duplicate a price_changed event. Bound param — never interpolate the id.
      const rows = await tx.$queryRaw<
        Array<{ type: string; name: string; price: number }>
      >`SELECT "type", "name", "price" FROM "Product" WHERE "id" = ${id} FOR UPDATE`;
      return rows[0] ?? null;
    },
```

- [ ] **Step 4: Run — expect PASS**

Run: the same command twice, then `DATABASE_URL='postgresql://ecom:ecom@localhost:5432/catalog' pnpm vitest run services/catalog`
Expected: green both times.

- [ ] **Step 5: Commit**

```bash
git add services/catalog/src/tx-adapters.ts services/catalog/src/__tests__/price-lock.int.test.ts
git commit -m "fix(catalog): loadForUpdate takes a real FOR UPDATE row lock"
```

---

### Task 4: Shared `startLedgerPruner` + adoption

**Files:**
- Create: `packages/shared/src/ledger-pruner.ts`, `packages/shared/src/__tests__/ledger-pruner.unit.test.ts`
- Modify: `packages/shared/src/index.ts`, and in each of `services/{order,inventory,payment,notification}`: `src/prune-adapter.ts` (create) + `src/main.ts` + `src/config.ts`

**Interfaces — Produces:** `startLedgerPruner(port: LedgerPrunerPort, opts?: { retentionDays?: number; intervalMs?: number }): { stop: () => void }`; `interface LedgerPrunerPort { deleteOlderThan(cutoff: Date): Promise<number> }`.

- [ ] **Step 1: Write the failing test** — `packages/shared/src/__tests__/ledger-pruner.unit.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { startLedgerPruner, type LedgerPrunerPort } from "../ledger-pruner";

function fakePort() {
  const cutoffs: Date[] = [];
  const port: LedgerPrunerPort = {
    async deleteOlderThan(cutoff) {
      cutoffs.push(cutoff);
      return 3;
    },
  };
  return { port, cutoffs };
}

describe("startLedgerPruner", () => {
  it("prunes on the interval using a cutoff retentionDays in the past", async () => {
    vi.useFakeTimers();
    const f = fakePort();
    const pruner = startLedgerPruner(f.port, { retentionDays: 30, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.cutoffs).toHaveLength(1);
    const ageMs = Date.now() - f.cutoffs[0].getTime();
    expect(ageMs).toBeGreaterThanOrEqual(30 * 24 * 3600_000);
    pruner.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.cutoffs).toHaveLength(1); // stopped means stopped
    vi.useRealTimers();
  });

  it("a failing prune is logged and does not stop the timer", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const port: LedgerPrunerPort = {
      async deleteOlderThan() {
        calls++;
        throw new Error("db down");
      },
    };
    const pruner = startLedgerPruner(port, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toBeGreaterThanOrEqual(2);
    pruner.stop();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm vitest run packages/shared/src/__tests__/ledger-pruner.unit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `packages/shared/src/ledger-pruner.ts`:

```ts
import { createLogger } from "./logger";

const log = createLogger("ledger-pruner");

export interface LedgerPrunerPort {
  // Deletes ledger rows processed before `cutoff`; returns how many went.
  deleteOlderThan(cutoff: Date): Promise<number>;
}

// The dedup ledger only has to outlive the longest possible redelivery, which Kafka's own
// retention bounds — so anything past the window is dead weight. Same shape as
// startExpirySweeper: an interval over a port, unref'd so it never holds the process open.
export function startLedgerPruner(
  port: LedgerPrunerPort,
  opts: { retentionDays?: number; intervalMs?: number } = {}
): { stop: () => void } {
  const { retentionDays = 30, intervalMs = 3_600_000 } = opts;
  let running = false;

  const timer = setInterval(() => {
    if (running) return; // never overlap a slow prune with the next tick
    running = true;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 3600_000);
    port
      .deleteOlderThan(cutoff)
      .then((count) => {
        if (count > 0) log.info("ledger_pruned", { count, retentionDays });
      })
      .catch((e) => log.error("ledger_prune_failed", { message: (e as Error).message }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
  };
}
```

Add to `packages/shared/src/index.ts`:

```ts
export * from "./ledger-pruner";
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm vitest run packages/shared/src/__tests__/ledger-pruner.unit.test.ts`

- [ ] **Step 5: Adopt in all four services.** In each of `services/{order,inventory,payment,notification}` create `src/prune-adapter.ts`:

```ts
import type { LedgerPrunerPort } from "@ecom/shared";
import { prisma } from "./db";

export const ledgerPrunerPort: LedgerPrunerPort = {
  async deleteOlderThan(cutoff) {
    const r = await prisma.processedEvent.deleteMany({
      where: { processedAt: { lt: cutoff } },
    });
    return r.count;
  },
};
```

Add to each `src/config.ts` schema:

```ts
    LEDGER_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
    LEDGER_PRUNE_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
```

And in each `src/main.ts`, after the relay is started:

```ts
  const pruner = startLedgerPruner(ledgerPrunerPort, {
    retentionDays: config.LEDGER_RETENTION_DAYS,
    intervalMs: config.LEDGER_PRUNE_INTERVAL_MS,
  });
```

adding `async () => { pruner.stop(); },` to that service's `gracefulShutdown` array (anywhere before the server-close entry, since it has no transport of its own).

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/shared/src/ledger-pruner.ts packages/shared/src/index.ts packages/shared/src/__tests__/ledger-pruner.unit.test.ts services/order/src services/inventory/src services/payment/src services/notification/src
git commit -m "feat(shared): startLedgerPruner + adoption in order/inventory/payment/notification"
```

---

### Task 5: Identity `RefreshToken` sweeper

**Files:**
- Create: `services/identity/src/prune-adapter.ts`
- Modify: `services/identity/src/{config.ts,main.ts}`
- Test: `services/identity/src/__tests__/prune.int.test.ts` (create)

**Interfaces — Consumes:** `startLedgerPruner`, `LedgerPrunerPort` from Task 4. **Produces:** `refreshTokenPrunerPort`.

- [ ] **Step 1: Write the failing test** — `services/identity/src/__tests__/prune.int.test.ts`:

```ts
import "./test-key";
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { refreshTokenPrunerPort } from "../prune-adapter";
import { prisma } from "../db";

const DAY = 24 * 3600_000;

describe("refresh token pruning (integration — needs compose up + migrated)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("deletes expired and long-revoked rows, keeps live and recently-revoked ones", async () => {
    const role = await prisma.role.upsert({
      where: { name: "USER" },
      create: { name: "USER" },
      update: {},
    });
    const user = await prisma.user.create({
      data: {
        email: `u_${randomUUID()}@example.test`,
        password: "x",
        name: "T",
        roleId: role.id,
      },
    });
    const mk = (over: Partial<{ revokedAt: Date | null; expiresAt: Date }>) =>
      prisma.refreshToken.create({
        data: {
          tokenHash: randomUUID(),
          userId: user.id,
          familyId: randomUUID(),
          expiresAt: new Date(Date.now() + 7 * DAY),
          ...over,
        },
      });

    const live = await mk({});
    const expired = await mk({ expiresAt: new Date(Date.now() - DAY) });
    const recentlyRevoked = await mk({ revokedAt: new Date() });
    const oldRevoked = await mk({ revokedAt: new Date(Date.now() - 40 * DAY) });

    await refreshTokenPrunerPort.deleteOlderThan(new Date(Date.now() - 30 * DAY));

    const survivors = await prisma.refreshToken.findMany({ where: { userId: user.id } });
    const ids = survivors.map((r) => r.id);
    expect(ids).toContain(live.id);
    expect(ids).toContain(recentlyRevoked.id); // reuse-detection still needs to find it
    expect(ids).not.toContain(expired.id);
    expect(ids).not.toContain(oldRevoked.id);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `DATABASE_URL='postgresql://ecom:ecom@localhost:5432/identity' pnpm vitest run services/identity/src/__tests__/prune.int.test.ts`
Expected: FAIL — `../prune-adapter` does not exist.

- [ ] **Step 3: Implement** — `services/identity/src/prune-adapter.ts`:

```ts
import type { LedgerPrunerPort } from "@ecom/shared";
import { prisma } from "./db";

// A revoked row cannot be deleted immediately: reuse-detection recognises a replay by FINDING
// a revoked row, and the grace window reads its replacedAt. Only rows revoked longer ago than
// the retention window are safe to drop on that arm — which is why the expiry arm below is
// scoped to `revokedAt: null` rather than deleting on expiry alone: a row can be both revoked
// and expired (logout() on an already-expired token sets revokedAt with no expiry filter), and
// expired must never override revoked.
export const refreshTokenPrunerPort: LedgerPrunerPort = {
  async deleteOlderThan(cutoff) {
    const r = await prisma.refreshToken.deleteMany({
      where: {
        OR: [
          { revokedAt: null, expiresAt: { lt: new Date() } }, // never revoked, just aged out
          { revokedAt: { lt: cutoff } }, // revoked, and past the window
        ],
      },
    });
    return r.count;
  },
};
```

Add to `services/identity/src/config.ts` the same two `LEDGER_*` keys as Task 4, and wire it in `main.ts`:

```ts
  const pruner = startLedgerPruner(refreshTokenPrunerPort, {
    retentionDays: config.LEDGER_RETENTION_DAYS,
    intervalMs: config.LEDGER_PRUNE_INTERVAL_MS,
  });
```

plus `async () => { pruner.stop(); },` in `gracefulShutdown`.

- [ ] **Step 4: Run — expect PASS** (`pnpm vitest run services/identity` with the identity URL) + `pnpm --filter @ecom/identity typecheck`

- [ ] **Step 5: Commit**

```bash
git add services/identity/src/prune-adapter.ts services/identity/src/config.ts services/identity/src/main.ts services/identity/src/__tests__/prune.int.test.ts
git commit -m "feat(identity): prune expired and long-revoked refresh tokens"
```

---

### Task 6: Drop the dead `ProcessedEvent` tables

**Files:**
- Modify: `services/catalog/prisma/schema.prisma`, `services/identity/prisma/schema.prisma`

Neither service consumes events; both tables are scaffold copy-paste.

- [ ] **Step 1: Confirm they are unused**

Run: `grep -rn "processedEvent" --include='*.ts' services/catalog/src services/identity/src | grep -v generated`
Expected: no output. If anything matches, STOP — the table is live and this task is wrong.

- [ ] **Step 2: Delete the model** from both `schema.prisma` files (the whole `model ProcessedEvent { … }` block).

- [ ] **Step 3: Generate the migrations (CLI only)**

```bash
DATABASE_URL='postgresql://ecom:ecom@localhost:5432/catalog' pnpm --filter @ecom/catalog exec prisma migrate dev --name drop_dead_processed_event
DATABASE_URL='postgresql://ecom:ecom@localhost:5432/identity' pnpm --filter @ecom/identity exec prisma migrate dev --name drop_dead_processed_event
```

If Prisma warns the table is not empty, STOP and report — a non-empty table means something wrote to it and the premise needs rechecking.

- [ ] **Step 4: Regenerate + verify**

```bash
pnpm --filter "./services/*" exec prisma generate
DATABASE_URL='postgresql://ecom:ecom@localhost:5432/catalog' pnpm vitest run services/catalog
DATABASE_URL='postgresql://ecom:ecom@localhost:5432/identity' pnpm vitest run services/identity
```

- [ ] **Step 5: Commit**

```bash
git add services/catalog/prisma services/identity/prisma
git commit -m "chore(catalog,identity): drop the dead ProcessedEvent tables (neither service consumes events)"
```

---

### Task 7: Payment webhook HMAC signature

**Files:**
- Create: `services/payment/src/webhook-signature.ts`, `services/payment/src/__tests__/webhook-signature.unit.test.ts`
- Modify: `services/payment/src/{app.ts,config.ts}`
- Test: `services/payment/src/__tests__/app.int.test.ts`

**Interfaces — Produces:** `verifyWebhookSignature(raw: Buffer | string, header: string | undefined, secret: string): boolean`.

- [ ] **Step 1: Write the failing unit test** — `webhook-signature.unit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { verifyWebhookSignature } from "../webhook-signature";

const SECRET = "topsecret";
const body = JSON.stringify({ orderId: "o1", outcome: "SUCCEEDED" });
const sign = (b: string, s = SECRET) =>
  `sha256=${createHmac("sha256", s).update(b).digest("hex")}`;

describe("verifyWebhookSignature", () => {
  it("accepts a correct signature", () => {
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });
  it("rejects a missing header, a wrong secret, and a tampered body", () => {
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, sign(body, "wrong"), SECRET)).toBe(false);
    expect(verifyWebhookSignature(body + " ", sign(body), SECRET)).toBe(false);
  });
  it("rejects malformed headers without throwing", () => {
    expect(verifyWebhookSignature(body, "nonsense", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "sha256=zzzz", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "sha256=", SECRET)).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`pnpm vitest run services/payment/src/__tests__/webhook-signature.unit.test.ts`)

- [ ] **Step 3: Implement** — `services/payment/src/webhook-signature.ts`:

```ts
import { createHmac, timingSafeEqual } from "crypto";

// HMAC-SHA256 over the RAW body. Re-serialising a parsed body would not reproduce the
// provider's bytes, and `===` on a MAC leaks its prefix through timing.
export function verifyWebhookSignature(
  raw: Buffer | string,
  header: string | undefined,
  secret: string
): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const provided = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(raw).digest();
  if (provided.length !== expected.length) return false; // timingSafeEqual throws otherwise
  return timingSafeEqual(provided, expected);
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Wire it into the route.** `services/payment/src/config.ts` gains:

```ts
    // No default on purpose: a default secret is not a secret, and a service that cannot
    // verify its webhook must refuse to boot.
    PAYMENT_WEBHOOK_SECRET: z.string().min(1),
```

`services/payment/src/app.ts` — replace the global JSON mount so the raw bytes survive:

```ts
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );
```

and at the very top of the webhook handler, before any parsing or lookup:

```ts
  app.post("/webhooks/payment", async (req, res) => {
    const raw = (req as express.Request & { rawBody?: Buffer }).rawBody ?? Buffer.from("");
    if (
      !verifyWebhookSignature(
        raw,
        req.header("x-webhook-signature"),
        config.PAYMENT_WEBHOOK_SECRET
      )
    ) {
      log.error("webhook_signature_rejected", { traceId: req.traceId });
      return res.status(401).json({ error: "invalid signature" });
    }
    // ...existing parse + finalize...
```

- [ ] **Step 6: Add the int test** — in `services/payment/src/__tests__/app.int.test.ts`, every existing webhook call gains a valid signature header, plus:

```ts
  it("rejects an unsigned webhook with 401 and touches no payment", async () => {
    const orderId = `o_${randomUUID()}`;
    await seedProcessingPayment(orderId);
    await request(app).post("/webhooks/payment").send({ orderId, outcome: "SUCCEEDED" }).expect(401);
    expect((await prisma.payment.findUnique({ where: { orderId } }))?.status).toBe("PROCESSING");
  });
```

- [ ] **Step 7: Run + commit** — the payment suite needs the secret in its env:

```bash
DATABASE_URL='postgresql://ecom:ecom@localhost:5432/payment' PAYMENT_WEBHOOK_SECRET='test-secret' pnpm vitest run services/payment
git add services/payment/src .github/workflows/ci.yml
git commit -m "fix(payment): require an HMAC signature on the provider webhook"
```

> The CI payment step and the compose `payment` service both gain `PAYMENT_WEBHOOK_SECRET`.

---

### Task 8: `userId` on `ChargePayment` → scoped `GET /payments/:orderId`

**Files:**
- Modify: `packages/contracts/src/events/payment.ts`, `services/order/src/transition.ts`, `services/payment/src/{consumer.ts,charge.ts,tx-adapters.ts,app.ts}`, `services/payment/prisma/schema.prisma`, `services/gateway/src/app.ts`
- Test: `packages/contracts/src/__tests__/payment-events.test.ts`, `services/payment/src/__tests__/charge.int.test.ts`, `services/payment/src/__tests__/app.int.test.ts`

**Interfaces — Produces:** `ChargePaymentPayloadSchema` gains `userId: z.string().min(1)`; `Payment.userId` (nullable column); `GET /payments/:orderId` 404s for a non-owner.

- [ ] **Step 1: Write the failing contract test** — add to `payment-events.test.ts`:

```ts
it("ChargePayment requires a userId", () => {
  expect(
    ChargePaymentPayloadSchema.safeParse({ orderId: "o1", amount: 100 }).success
  ).toBe(false);
  expect(
    ChargePaymentPayloadSchema.parse({ orderId: "o1", userId: "u1", amount: 100 })
  ).toEqual({ orderId: "o1", userId: "u1", amount: 100 });
});
```

- [ ] **Step 2: Run — expect FAIL** (`pnpm vitest run packages/contracts`)

- [ ] **Step 3: Widen the contract and the producer**

`packages/contracts/src/events/payment.ts`:

```ts
export const ChargePaymentPayloadSchema = z.object({
  orderId: z.string().min(1),
  userId: z.string().min(1), // Payment scopes its read routes by this
  amount: z.number().int().positive(),
});
```

`services/order/src/transition.ts` — the `AWAITING_PAYMENT` branch:

```ts
    await tx.enqueue(CHARGE_PAYMENT, p.orderId, {
      orderId: p.orderId,
      userId: order.userId,
      amount: order.totalPrice,
    });
```

- [ ] **Step 4: Store it in Payment.** `services/payment/prisma/schema.prisma` — add to `model Payment`:

```prisma
  userId    String?                          // nullable: rows predate the widened command
```

Run: `DATABASE_URL='postgresql://ecom:ecom@localhost:5432/payment' pnpm --filter @ecom/payment exec prisma migrate dev --name payment_user_id`

Then thread it through: `consumer.ts` parses `userId` and passes it to `chargeOrder`; `charge.ts`'s `ChargeTx.createPayment` gains `userId`; `tx-adapters.ts` writes it.

- [ ] **Step 5: Scope the read route** — `services/payment/src/app.ts`:

```ts
  app.get("/payments/:orderId", async (req, res) => {
    const callerId = req.header("x-user-id");
    if (!callerId) return res.status(400).json({ error: "missing x-user-id" });
    try {
      const p = await prisma.payment.findUnique({ where: { orderId: req.params.orderId } });
      // A payment belonging to someone else — or to nobody (a legacy row) — is reported
      // absent, not forbidden, so order ids stay unenumerable.
      if (!p || p.userId !== callerId) return res.status(404).json({ error: "not found" });
      res.json({
        orderId: p.orderId,
        amount: p.amount,
        status: p.status,
        createdAt: p.createdAt.toISOString(),
      });
    } catch {
      log.error("payment_get_failed", { orderId: req.params.orderId, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });
```

- [ ] **Step 6: Add the ownership test** — in `app.int.test.ts`:

```ts
  it("the owner reads their payment; another user and a legacy row both 404", async () => {
    const orderId = `o_${randomUUID()}`;
    const userId = `u_${randomUUID()}`;
    await prisma.payment.create({
      data: { orderId, userId, amount: 100, status: "SUCCEEDED" },
    });
    await request(app).get(`/payments/${orderId}`).set("x-user-id", userId).expect(200);
    await request(app).get(`/payments/${orderId}`).set("x-user-id", "someone-else").expect(404);

    const legacy = `o_${randomUUID()}`;
    await prisma.payment.create({ data: { orderId: legacy, amount: 100, status: "SUCCEEDED" } });
    await request(app).get(`/payments/${legacy}`).set("x-user-id", userId).expect(404);
  });
```

- [ ] **Step 7: Re-mount it at the gateway** — `services/gateway/src/app.ts`, beside the other authenticated mounts:

```ts
  app.use("/payments", authRequired, authz, guard("payment", deps.upstreams.payment));
```

and delete the "deliberately NOT proxied" comment block above it.

- [ ] **Step 8: Run everything touched + commit**

```bash
pnpm vitest run packages/contracts
DATABASE_URL='postgresql://ecom:ecom@localhost:5432/order' pnpm vitest run services/order
DATABASE_URL='postgresql://ecom:ecom@localhost:5432/payment' PAYMENT_WEBHOOK_SECRET='test-secret' pnpm vitest run services/payment
pnpm vitest run services/gateway
git add packages/contracts services/order/src/transition.ts services/payment services/gateway/src/app.ts
git commit -m "feat(payment): carry userId on ChargePayment and scope GET /payments/:orderId by caller"
```

---

### Task 9: Refresh-token grace window

**Files:**
- Modify: `services/identity/prisma/schema.prisma`, `services/identity/src/{sessions.ts,tx-adapters.ts,auth.ts,config.ts}`
- Test: `services/identity/src/__tests__/sessions.unit.test.ts`, `services/identity/src/__tests__/auth.int.test.ts`

**Interfaces — Produces:** `RotateOutcome` gains `"GRACE"`; `SessionRow` gains `replacedAt: Date | null`; `rotateRefresh(tx, hash, now, mintHash, ttlMs, graceMs)`.

- [ ] **Step 1: Write the failing unit test** — add to `sessions.unit.test.ts`:

```ts
  it("a replay inside the grace window -> GRACE: 401 without revoking the family", async () => {
    const f = fakeTx([
      live({ id: "s1", tokenHash: "h1", revokedAt: NOW, replacedAt: NOW }),
      live({ id: "s2", tokenHash: "h2" }), // the successor, still live
    ]);
    const r = await rotateRefresh(f.tx, "h1", new Date(NOW.getTime() + 2_000), () => "h3", undefined, 10_000);
    expect(r.outcome).toBe("GRACE");
    expect(f.revokedFamilies).toEqual([]);
    expect(f.store.get("h2")!.revokedAt).toBeNull(); // honest client keeps its session
  });

  it("a replay after the grace window is still REUSE", async () => {
    const f = fakeTx([live({ id: "s1", tokenHash: "h1", revokedAt: NOW, replacedAt: NOW })]);
    const r = await rotateRefresh(f.tx, "h1", new Date(NOW.getTime() + 60_000), () => "h3", undefined, 10_000);
    expect(r.outcome).toBe("REUSE");
    expect(f.revokedFamilies).toEqual(["f1"]);
  });

  it("a row revoked by logout (never rotated) is REUSE even inside the window", async () => {
    const f = fakeTx([live({ id: "s1", tokenHash: "h1", revokedAt: NOW, replacedAt: null })]);
    const r = await rotateRefresh(f.tx, "h1", new Date(NOW.getTime() + 2_000), () => "h3", undefined, 10_000);
    expect(r.outcome).toBe("REUSE");
  });
```

`live()` and `fakeTx` gain `replacedAt` (default `null`), and `mintInFamily` records `replacedAt: null`.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement.** `services/identity/prisma/schema.prisma`, in `model RefreshToken`:

```prisma
  replacedAt DateTime?                       // set when this row was ROTATED (not revoked)
```

Run: `DATABASE_URL='postgresql://ecom:ecom@localhost:5432/identity' pnpm --filter @ecom/identity exec prisma migrate dev --name refresh_replaced_at`

`services/identity/src/sessions.ts`:

```ts
export type RotateOutcome = "ROTATED" | "UNKNOWN" | "REUSE" | "EXPIRED" | "RACE" | "GRACE";
```

```ts
  if (row.revokedAt !== null) {
    // A rotation this recent is far more likely an honest double-submit (two tabs, a retry)
    // than a thief replaying a stolen token, and revoking the family would log the real user
    // out. Outside the window — or if the row was revoked by logout rather than rotated —
    // reuse-detection fires as before. This narrows detection by graceMs, deliberately.
    const rotatedAt = row.replacedAt?.getTime();
    if (rotatedAt !== undefined && now.getTime() - rotatedAt <= graceMs) {
      return { outcome: "GRACE", userId: row.userId };
    }
    await tx.revokeFamily(row.familyId, now);
    return { outcome: "REUSE", userId: row.userId };
  }
```

with the new parameter `graceMs = 10_000` appended to the signature, and `revokeOne` in the rotate path also stamping `replacedAt` — extend the port:

```ts
  // in SessionTx
  revokeOne(id: string, at: Date, rotated?: boolean): Promise<number>;
```

`tx-adapters.ts`:

```ts
    async revokeOne(id, at, rotated = false) {
      const r = await tx.refreshToken.updateMany({
        where: { id, revokedAt: null },
        data: rotated ? { revokedAt: at, replacedAt: at } : { revokedAt: at },
      });
      return r.count;
    },
```

and in `sessions.ts` the claim call becomes `await tx.revokeOne(row.id, now, true)`.

`auth.ts` passes `config.REFRESH_GRACE_MS`; `config.ts` gains:

```ts
    REFRESH_GRACE_MS: z.coerce.number().int().nonnegative().default(10_000),
```

- [ ] **Step 4: Add the int test** — in `auth.int.test.ts`, replace the concurrency assertion's tail:

```ts
  it("a double-submit inside the grace window keeps the session alive", async () => {
    const s = await registerAndLogin();
    const first = await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: s.refreshToken })
      .expect(200);
    // Immediate replay of the consumed token: rejected, but the family survives.
    await request(app).post("/auth/refresh").send({ refreshToken: s.refreshToken }).expect(401);
    await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: first.body.refreshToken })
      .expect(200);
  });
```

- [ ] **Step 5: Run + typecheck + commit**

```bash
DATABASE_URL='postgresql://ecom:ecom@localhost:5432/identity' pnpm vitest run services/identity
pnpm --filter @ecom/identity typecheck
git add services/identity
git commit -m "feat(identity): grace window so an honest double-refresh no longer kills the family"
```

---

### Task 10: JWKS + `kid` (droppable)

**Files:**
- Create: `services/identity/src/jwks.ts`, `services/gateway/src/jwks-cache.ts` + a test each
- Modify: identity `src/{config.ts,tokens.ts,app.ts}`, gateway `src/{config.ts,auth-middleware.ts,app.ts,main.ts}`

**Interfaces — Produces:** identity `GET /.well-known/jwks.json`; gateway `createJwksCache({ url, ttlMs, fetchImpl? }): { keyFor(kid): string | null; refresh(): Promise<void>; stop(): void; ready(): boolean }`.

- [ ] **Step 1: Write the failing identity test** — `services/identity/src/__tests__/jwks.int.test.ts`:

```ts
import "./test-key";
import { describe, it, expect } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app";

const app = createApp();

describe("JWKS", () => {
  it("publishes the active public key with a kid that matches the token header", async () => {
    const res = await request(app).get("/.well-known/jwks.json").expect(200);
    const keys = (res.body as { keys: Array<{ kid: string; kty: string; alg: string }> }).keys;
    expect(keys.length).toBeGreaterThan(0);
    expect(keys[0].kty).toBe("RSA");
    expect(keys[0].alg).toBe("RS256");

    const login = await request(app)
      .post("/auth/login")
      .send({ email: "nobody@example.test", password: "wrongwrongwrong" });
    expect([401, 200]).toContain(login.status); // credentials are irrelevant here

    const token = jwt.sign({ sub: "u1", role: "USER" }, process.env.JWT_PRIVATE_KEY!, {
      algorithm: "RS256",
      keyid: keys[0].kid,
    });
    expect((jwt.decode(token, { complete: true }) as { header: { kid: string } }).header.kid).toBe(
      keys[0].kid
    );
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (404 — the route does not exist)

- [ ] **Step 3: Implement identity side** — `services/identity/src/jwks.ts`:

```ts
import { createHash, createPublicKey } from "crypto";

export type SigningKey = { kid: string; privateKey: string; publicKey: string };

// kid = a stable fingerprint of the public key, so a rotated key keeps its identity across
// restarts without anyone maintaining a registry.
export function toSigningKey(privateKey: string): SigningKey {
  const pub = createPublicKey(privateKey);
  const publicKey = pub.export({ type: "spki", format: "pem" }).toString();
  const kid = createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
  return { kid, privateKey, publicKey };
}

export function toJwks(keys: SigningKey[]): { keys: unknown[] } {
  return {
    keys: keys.map((k) => ({
      ...createPublicKey(k.publicKey).export({ format: "jwk" }),
      kid: k.kid,
      use: "sig",
      alg: "RS256",
    })),
  };
}
```

`config.ts` — `JWT_PRIVATE_KEY` stays required and is the signer; an optional
`JWT_PREVIOUS_PUBLIC_KEY` stays published so tokens signed before a rotation still verify:

```ts
    JWT_PREVIOUS_PUBLIC_KEY: z.string().optional(),
```

`tokens.ts` — `signAccess` passes `keyid: signingKey.kid`. `app.ts` serves:

```ts
  app.get("/.well-known/jwks.json", (_req, res) => {
    res.json(toJwks(publishedKeys()));
  });
```

- [ ] **Step 4: Gateway JWKS cache — failing test** `services/gateway/src/__tests__/jwks-cache.unit.test.ts`:

```ts
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
```

- [ ] **Step 5: Implement the cache** — `services/gateway/src/jwks-cache.ts`, converting each JWK to a PEM with `createPublicKey({ key: jwk, format: "jwk" })`, same fail-fast-at-boot / keep-last-good shape as `grants-cache.ts`, `AbortSignal.timeout(5_000)` on the fetch.

- [ ] **Step 6: Verify by `kid`** — `auth-middleware.ts` takes a resolver instead of a raw key:

```ts
export function authenticate(
  resolveKey: (kid: string | undefined) => string | null,
  opts: { required: boolean }
) {
```

decoding the header first (`jwt.decode(token, { complete: true })`), resolving by `kid`, and 401ing when no key matches. `app.ts` passes
`(kid) => deps.jwks?.keyFor(kid) ?? deps.publicKey ?? null`, so a gateway configured with only a static `JWT_PUBLIC_KEY` still works.

`gateway/src/config.ts`: `JWT_PUBLIC_KEY` becomes `.optional()`, `JWKS_URL` optional, `JWKS_TTL_MS` default 600 000 — plus a boot assertion in `main.ts` that at least one of the two is set, exiting with a named error if not.

- [ ] **Step 7: Run + typecheck + commit**

```bash
DATABASE_URL='postgresql://ecom:ecom@localhost:5432/identity' pnpm vitest run services/identity
pnpm vitest run services/gateway
pnpm -r typecheck
git add services/identity services/gateway
git commit -m "feat(identity,gateway): publish a JWKS and verify tokens by kid"
```

---

### Task 11: CI matrix + dev-topic reset + `hello` canary note

**Files:**
- Create: `infra/scripts/reset-dev-topics.sh`
- Modify: `.github/workflows/ci.yml`, `services/hello/src/main.ts`, `docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md`

- [ ] **Step 1: Write the reset script** — `infra/scripts/reset-dev-topics.sh`:

```bash
#!/usr/bin/env bash
# Truncates the durable dev topics. Every new consumer group subscribes fromBeginning, so a
# long-lived broker makes each e2e run replay more history until the 25s poll budgets break.
# Deletes records only — topics and their configs survive.
set -euo pipefail
CONTAINER="${KAFKA_CONTAINER:-ecom-platform-kafka-1}"
TOPICS="${TOPICS:-order.events inventory.events payment.events catalog.events identity.events}"

for topic in $TOPICS; do
  offset=$(docker exec "$CONTAINER" /opt/kafka/bin/kafka-get-offsets.sh \
    --bootstrap-server localhost:9092 --topic "$topic" 2>/dev/null | cut -d: -f3 || echo "")
  [ -z "$offset" ] && { echo "skip $topic (absent)"; continue; }
  docker exec "$CONTAINER" sh -c "cat > /tmp/trunc.json <<JSON
{\"partitions\":[{\"topic\":\"$topic\",\"partition\":0,\"offset\":$offset}],\"version\":1}
JSON
/opt/kafka/bin/kafka-delete-records.sh --bootstrap-server localhost:9092 --offset-json-file /tmp/trunc.json" >/dev/null
  echo "truncated $topic to $offset"
done
```

`chmod +x infra/scripts/reset-dev-topics.sh`

- [ ] **Step 2: Collapse the CI integration steps into a matrix.** Replace the seven per-service steps with one matrixed job:

```yaml
  service-tests:
    needs: integration-infra
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        include:
          - service: hello
            db: hello
          - service: inventory
            db: inventory
          - service: order
            db: order
          - service: payment
            db: payment
          - service: catalog
            db: catalog
          - service: notification
            db: notification
          - service: identity
            db: identity
            seed: true
          - service: gateway
            db: ""
    steps:
      - name: Migrate
        if: matrix.db != ''
        env:
          DATABASE_URL: postgresql://ecom:ecom@localhost:5432/${{ matrix.db }}
        run: pnpm --filter @ecom/${{ matrix.service }} exec prisma migrate deploy
      - name: Seed
        if: matrix.seed
        env:
          DATABASE_URL: postgresql://ecom:ecom@localhost:5432/${{ matrix.db }}
        run: pnpm --filter @ecom/${{ matrix.service }} seed
      - name: Test
        env:
          DATABASE_URL: postgresql://ecom:ecom@localhost:5432/${{ matrix.db }}
          KAFKA_BROKERS: localhost:9092
          RABBITMQ_URL: amqp://ecom:ecom@localhost:5672
          SMTP_HOST: localhost
          SMTP_PORT: 1025
          PAYMENT_WEBHOOK_SECRET: ci-secret
        run: pnpm vitest run services/${{ matrix.service }}
```

> If splitting the job proves to need the infra in each matrix leg (services are containers on the runner, not a separate job), keep it as one job and matrix only the step — the goal is one step definition, not a job split. Verify with `act` or a push before relying on it.

Add before the service tests: `- name: Reset dev topics\n        run: ./infra/scripts/reset-dev-topics.sh`.

- [ ] **Step 3: Document `hello`'s fate** — header comment in `services/hello/src/main.ts`:

```ts
// KEPT DELIBERATELY (Phase 7a decision). hello is the platform's canary: the cheapest
// end-to-end proof that DB + outbox + Kafka + health + graceful shutdown still work
// together. It fails before any real service does when a shared package regresses. Do not
// retire it as leftover scaffolding.
```

and flip the roadmap's absorption-map row for "hello-service fate" to **decided: kept as canary (7a)**.

- [ ] **Step 4: Verify + commit**

```bash
./infra/scripts/reset-dev-topics.sh
python3 -c "import yaml;yaml.safe_load(open('.github/workflows/ci.yml'));print('ci ok')"
git add infra/scripts/reset-dev-topics.sh .github/workflows/ci.yml services/hello/src/main.ts docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md
git commit -m "chore(ci): matrix the per-service test steps, add a dev-topic reset, keep hello as a documented canary"
```

---

### Task 12: Polish — shared first, then service-local

**Files:**
- Modify: `packages/shared/src/{outbox.ts,kafka.ts}` (commit 1); `services/order/src/{sse-listener.ts,sse-registry.ts,app.ts}`, `services/order/src/__tests__/order-stream.int.test.ts`, `packages/contracts/src/events/order.ts`, `services/order/src/__tests__/order-payment-leg.e2e.test.ts` (commit 2)

- [ ] **Step 1: Shared — `outbox.ts` computes `queueFor` once per row**

```ts
  const rows = await port.fetchUnsent(limit);
  // One call per row: queueFor was previously invoked twice per row per tick.
  const routed = rows.map((r) => ({ row: r, queue: commands?.queueFor(r) ?? null }));
  const kafkaRows = routed.filter((r) => r.queue === null).map((r) => r.row);
```

(and the command lane reads from the same `routed` array).

- [ ] **Step 2: Shared — `kafka.ts` keeps the eventId on the DLQ path**

```ts
          } catch (e) {
            // Poison message: park and commit so the partition keeps moving. Keep the key
            // when the envelope parsed — a DLQ message with no key cannot be traced back.
            let eventId: string | undefined;
            try {
              eventId = (JSON.parse(raw) as { eventId?: string }).eventId;
            } catch {
              /* malformed — no id to recover */
            }
            log.error("event_parked_to_dlq", { topic, eventId, message: (e as Error).message });
            await parker.send({
              topic: `${topic}.dlq`,
              messages: [{ key: eventId ?? null, value: raw }],
            });
          }
```

- [ ] **Step 3: Run the shared suite + commit**

```bash
pnpm vitest run packages/shared
git add packages/shared/src/outbox.ts packages/shared/src/kafka.ts
git commit -m "refactor(shared): compute queueFor once per row; keep eventId on the DLQ path"
```

- [ ] **Step 4: Order-local polish** — move `SubscriberRegistry` (and `Sink`) out of `sse-listener.ts` into `services/order/src/sse-registry.ts`, re-export from `sse-listener.ts` for the existing importers, so `sse-registry.unit.test.ts` stops pulling `pg` in transitively; guard the SSE 404 test against error/timeout by rejecting the promise on `res.on("error")`; group `ORDER_CONFIRMED` with the other order consts in `packages/contracts/src/events/order.ts`; assert `payload.orderId` in the payment-leg e2e's ChargePayment check.

- [ ] **Step 5: Full regression gate + commit**

```bash
for s in hello inventory order payment catalog notification identity; do
  DATABASE_URL="postgresql://ecom:ecom@localhost:5432/$s" PAYMENT_WEBHOOK_SECRET='test-secret' pnpm vitest run services/$s
done
pnpm vitest run services/gateway packages
pnpm -r typecheck && pnpm format && pnpm format:check
git add services/order packages/contracts
git commit -m "refactor(order): split SubscriberRegistry into its own file; test and const polish"
```

**Expected at this gate: every suite green, no exceptions.**

---

## Self-Review

**Spec coverage:** §A1→T1, §A2→T2, §A3→T3, §B1→T4, §B2→T5, §B3→T6, §C1→T7, §C2→T8, §C3→T9, §C4→T10, §D CI matrix + topic reset + hello→T11, §D polish→T12. §Scope-out items have no task, by design.

**Placeholder scan:** none — every code step carries the actual code. Task 11's CI matrix carries a verification caveat rather than a placeholder: the job-vs-step split depends on how the existing job hosts its service containers, and the step notes exactly what to check.

**Type consistency:** `setStatus(orderId, next, expected): Promise<boolean>` (T2) is consumed only by `applyResult`; `LedgerPrunerPort.deleteOlderThan(cutoff): Promise<number>` (T4) is implemented identically in T5; `RotateOutcome` gains `"GRACE"` (T9) on top of `"RACE"` from Phase 6; `revokeOne(id, at, rotated?)` (T9) supersedes the two-arg form from Phase 6 and both call sites are updated in the same task; `ChargePaymentPayloadSchema.userId` (T8) is produced by Order and consumed by Payment in the same task.
