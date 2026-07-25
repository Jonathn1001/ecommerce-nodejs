# Phase 7a · Correctness & hygiene debt — Design (child spec)

> Phase 7 (Hardening, XL) is decomposed into four slices — **7a correctness & hygiene debt**
> (this doc), 7b metrics, 7c tracing, 7d verification (k6 + chaos) — plus the two umbrella
> lesson items (orchestrated-saga variant, schema-evolution `v1→v2`). User decisions: debt
> first, and **the entire tracked backlog lands here in one pass** so later slices start
> clean. Reference: `docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md` (Phase 7 +
> "Backlog absorption map").

## Purpose

Close every correctness, security and hygiene deferral accumulated across Phases 3–6 before
the wide instrumentation diffs of 7b/7c land on top of them. Two concrete motivations:

1. **The suite is not green.** `services/inventory/src/__tests__/sweeper.int.test.ts` has 2
   failing tests, carried since Phase 3a. Instrumenting a codebase with known-red tests
   makes every later failure ambiguous.
2. **One item is a live security hole.** `POST /webhooks/payment` is unauthenticated, so
   anyone who can reach the gateway can finalize a payment.

This slice has **no shared architecture** — it is a set of independent fixes, grouped so each
group is one plan task with its own tests. Groups are ordered by risk, not by convenience.

## Scope

**In:** the four groups below (§A–§D), covering every row of the roadmap's backlog-absorption
map assigned to Phase 7, plus the correctness and security deferrals opened by the Phase 5 and
Phase 6 reviews — **except the five listed immediately below**, which stay out by decision.

**Out — tracked items deliberately NOT in this slice** (listed so the Definition of Done can
actually be evaluated):
- **Notification's write-only `subject` column** (Phase 5 review): the worker re-renders from
  `type` + `orderId` and ignores the stored value. Cosmetic; no failure mode.
- **Concurrent duplicate email** (Phase 5, accepted): at-least-once with a best-effort sent
  marker. Never loses or wedges a notification.
- **Catalog comment author-ownership**: `Comment` records no author at all, so deletion is a
  moderation action and stays ADMIN-only — **decided, not deferred** (§E decision 11).
- **Notification consumer for `identity.user_registered`** (welcome email): named backlog,
  unscheduled — a feature, not debt.
- **Discount projection into Order's read model**: named backlog, unscheduled.

**Out (and why):**
- **In-process reconnect** for the Rabbit adapter and the SSE `pg` LISTEN client. Decided
  **closed, not deferred again** (§E decision 3): the fail-fast + `restart: unless-stopped`
  contract works, is tested, and reconnect would rebuild consumers, channels and the relay
  command lane on top of a contract that already recovers in about a second.
- Metrics, tracing, k6, chaos, the orchestrated-saga variant and the schema-evolution event —
  later 7 slices.
- Debezium/logical-decoding outbox (umbrella stretch), cloud anything.
- Discount projection into Order's read model (named backlog, unscheduled).

---

## A. Latent concurrency and robustness bugs

### A1. Inventory `sweepOnce` per-order isolation

`services/inventory/src/sweeper.ts:52-64` already runs one transaction per order, but a throw
from any order escapes the `for` loop and abandons every remaining order in the batch. The
throw is reachable today: a reservation whose `Inventory` row no longer exists makes
`tx.inventory.update` raise Prisma `P2025`, which is exactly what fails the 2 sweeper tests —
stale dev-database rows poison the batch and the suite's own valid rows are never swept.

Fix: wrap each order in try/catch, log `{ orderId, message }` (ids only), continue, and return
the number of **reservations released by the orders that succeeded** — the unit `sweepOnce`
already returns — not the number of orders attempted. Same lane-isolation shape as the outbox relay tick.

> A poisoned reservation stays `ACTIVE` forever and is retried every sweep. That is correct —
> silently releasing stock against a missing inventory row would be worse — but it means the
> log line is the only signal. Named in §F.

### A2. Order `setStatus` compare-and-set

`services/order/src/tx-adapters.ts:75-77` is a bare `update`, so two events for one order
could both read `AWAITING_PAYMENT` and write contradictory terminal states. Unreachable today
(Payment emits exactly one deterministic result per order, and a single consumer group is
serial per partition), but Phase 3b raised the stakes and the guard is small.

- `TransitionTx.setStatus(orderId, next, expected)` → `Promise<boolean>`, implemented as
  `updateMany({ where: { id, status: expected }, data: { status: next } })`, returning
  `count > 0`.
- `applyResult` passes the status it read and returns **`NO_OP`** when the CAS loses, before
  emitting any event or notifying SSE. Losing the CAS must not emit a command.
- **The `ProcessedEvent` row stays.** `markProcessed` runs at `transition.ts:55`, before
  `setStatus` at :61, so a lost CAS commits the ledger row and returns `NO_OP`. That is
  deliberate: the CAS can only lose because another event legitimately advanced the order, so
  redelivering this one can never succeed. Do **not** "fix" it by rolling the transaction
  back — that would redeliver the event forever.

### A3. Catalog `loadForUpdate` → a real row lock

`services/catalog/src/tx-adapters.ts:17-23` is a plain `findUnique` despite its name, so two
concurrent price PATCHes can interleave read → read → write → write and either suppress or
duplicate `price_changed`. Replace with a bound-param `SELECT … FOR UPDATE` via `$queryRaw`
inside the existing transaction (the pattern Order already uses for `pg_notify`).

## B. Retention and lifecycle

### B1. `startLedgerPruner` in `@ecom/shared`

`ProcessedEvent` grows without bound in Order, Inventory, Payment and Notification. New
shared module, sibling to the expiry sweeper:

```ts
startLedgerPruner(port: LedgerPrunerPort, opts: { retentionDays?: number; intervalMs?: number })
  : { stop: () => void }
```

`LedgerPrunerPort.deleteOlderThan(cutoff: Date): Promise<number>` — each service supplies a
one-line Prisma adapter, keeping the shared module free of any client. Defaults:
`LEDGER_RETENTION_DAYS` 30, `LEDGER_PRUNE_INTERVAL_MS` 3 600 000 (hourly). Adopted from each `main.ts`; the timer is `unref`'d and stopped in `gracefulShutdown`.

**Retention window rationale:** the ledger only needs to outlive the longest possible
redelivery. Kafka's retention is the bound, so 30 days is generous by an order of magnitude
and cheap. Configurable per service via `LEDGER_RETENTION_DAYS`.

### B2. Identity `RefreshToken` sweeper

Same shape, in identity: delete rows past `expiresAt`, and revoked rows older than
`retentionDays`. Revoked rows cannot be pruned immediately — reuse-detection needs to find a
revoked row to recognise a replay (§C3's grace window depends on it too).

### B3. Drop the dead `ProcessedEvent` tables (catalog **and** identity)

Both are scaffold copy-paste from a consuming service, and neither consumes anything:
`services/catalog/prisma/schema.prisma:74` and `services/identity/prisma/schema.prisma` (added
in Phase 6 by cloning payment's scaffold). Remove both models, generate one migration per
service through the CLI, leave the folders untouched.

## C. Security debt

### C1. Payment webhook HMAC signature

`services/payment/src/app.ts:52` accepts an unauthenticated `POST /webhooks/payment`, and the
gateway proxies it without auth or CSRF by design (a provider callback has no session). Today
anyone who can reach the edge can finalize any `PROCESSING` payment.

- Header `x-webhook-signature: sha256=<hex>`, HMAC-SHA256 of the **raw** body with
  `PAYMENT_WEBHOOK_SECRET`, compared with `crypto.timingSafeEqual`.
- Requires the raw body. `services/payment/src/app.ts:14` mounts `express.json()` **globally**,
  so adding a second route-scoped parser would run after the body was already consumed and
  leave `req.rawBody` undefined — every signature would fail closed. The global mount is
  replaced by `express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })`.
  Re-serialising `req.body` is not an option: it would not reproduce the provider's bytes.
- Missing or bad signature → **401**, logged as `webhook_signature_rejected` with `orderId`
  only. Verification happens **before** the payload is parsed or the order is looked up.
- A `verifyWebhook(raw, header, secret): boolean` helper is pure and unit-tested; the route
  only wires it.

> Not replay protection. A captured valid request can be replayed; the finalize path is
> already idempotent (compare-and-set on `PROCESSING`), so a replay is a no-op. Timestamp +
> nonce is named in §F.

### C2. `userId` on `ChargePayment` → scoped `GET /payments/:orderId`

Phase 6 dropped `/payments` from the gateway because `Payment` has no `userId` to scope by.
Restore it properly — the only cross-service contract change in this slice, so it lands as its
own commit:

1. `ChargePaymentPayloadSchema` gains `userId: z.string().min(1)` (required, matching how
   `order.events` were widened in Phase 5).
2. Order's `applyResult` passes `order.userId` (already loaded by `loadOrder`).
3. `Payment.userId` column — **nullable**, so the migration applies to a table that already
   has rows — written by the charge consumer whenever the command carries it.
4. `GET /payments/:orderId` scopes by the injected `x-user-id` and answers **404** for a
   non-owner — 404, not 403, exactly as Order's ownership fix does.
5. The gateway re-mounts `/payments` with `authRequired`.

**Backward compatibility:** in-flight `ChargePayment` commands enqueued before deploy have no
`userId`, so the widened parse would reject them into the DLQ. The demo stack is disposable
and the DLQ replay path exists, so the spec accepts this; the migration adds the column as
nullable and the consumer writes it when present. Reads treat `userId === null` as "not
owned by anyone" → 404, so an unscopeable legacy row is never leaked.

### C3. Refresh-token grace window

Today a concurrent double-refresh is indistinguishable from a stolen-token replay, so the
family is revoked and an honest client is logged out (a Phase-6 known limitation).

- `RefreshToken.replacedAt` (the moment it was rotated) — `revokedAt` alone cannot tell a
  rotation from a revocation.
- On a replay of a revoked row: if it was **rotated** (not revoked for any other reason) and
  `now - replacedAt <= REFRESH_GRACE_MS` (default 10 000), return **`GRACE`** → 401 and
  **leave the family intact**. Outside the window, or if the row was revoked by logout or by
  a previous reuse, `REUSE` fires and the family dies as it does now.
- The successor is **not** re-issued to the second caller. A 401 that preserves the session is
  enough for a client to retry; handing the same successor to two callers would be a second
  way to fork a family.

> This narrows reuse-detection by design: a thief who replays within 10s of the honest
> rotation gets a 401 instead of burning the session. The trade is deliberate — the
> alternative logs real users out for double-clicking. Named in §F.

### C4. JWKS + key rotation (minimal)

Largest item in the slice, and **last on purpose**: it can be dropped without disturbing
anything above it.

- Identity signs with a `kid` in the JWT header. `IDENTITY_KEYS` holds one or two active
  keypairs (`kid:pem` pairs); the first is the signer, any listed key stays verifiable.
- `GET /.well-known/jwks.json` publishes the public halves as a JWKS (`kty: RSA`, `alg:
  RS256`, `use: sig`, per-key `kid`, `n`/`e` derived with Node's `createPublicKey().export({
  format: "jwk" })`).
- **Gateway config changes shape:** `JWT_PUBLIC_KEY` becomes optional and `JWKS_URL` is added,
  with a boot assertion that **at least one** is present — otherwise a misconfigured gateway
  boots healthy and 401s every request.
- The gateway replaces its static `JWT_PUBLIC_KEY` with a **JWKS cache** — the same
  fail-fast-at-boot / keep-last-good-on-refresh shape as the grants snapshot, keyed by `kid`.
  An unknown `kid` triggers one refresh, then 401. `JWT_PUBLIC_KEY` remains supported as a
  fallback so the gateway still boots against an identity that has not rotated.
- **Rotation is manual and documented, not automatic:** add the new key second, deploy,
  promote it to first, deploy, drop the old one once the longest access-token TTL has passed.

## D. Test and CI hygiene

- **CI matrix.** The integration job has 7 near-identical per-service steps. Collapse to one
  `strategy.matrix` step over `{ service, database, seed }`, with `hello` and the
  no-database services expressed as matrix rows rather than special cases.
- **Durable-topic reset.** `inventory.events` and friends grow every dev/CI run, and each new
  consumer group replays from the beginning — a latent breach of the 25s poll budgets, and
  already the cause of one truncation this session. Ship
  `infra/scripts/reset-dev-topics.sh` (the `kafka-delete-records` flow used by hand earlier)
  plus a CI step that runs it before the integration job.
- **`hello` stays, deliberately.** It is the cheapest end-to-end proof that the platform
  primitives (DB + outbox + Kafka + health + graceful shutdown) still work, and it fails
  before any real service does when a shared package regresses. Documented as an intentional
  canary in the roadmap's absorption map and in a header comment in `services/hello/src/main.ts`.
  **No per-service README** — no other service has one, and inventing the convention for a
  single decision is worse than putting it where a reader of that service will actually see it.
- **Polish**, split into two commits by blast radius — the `packages/shared` edits
  (`outbox.ts` `queueFor` compute-once; `kafka.ts` restoring `eventId` as the message key and a
  logged field on the retry-exhausted DLQ path) touch every service and land separately from
  the service-local ones: split `SubscriberRegistry` out of `sse-listener.ts`
  into its own file so a unit test stops pulling `pg` in transitively; guard the SSE 404 test
  against error/timeout; compute `queueFor` once per row in `outbox.ts`; restore `eventId` as
  the message key and a logged field on `kafka.ts`'s retry-exhausted DLQ path (today the
  parked message loses its key even when the envelope parsed fine); group the
  `ORDER_CONFIRMED` const with its siblings; assert `payload.orderId` in the payment-leg e2e.

## Configuration

New: `LEDGER_RETENTION_DAYS` (30) and `LEDGER_PRUNE_INTERVAL_MS` (3 600 000) in Order,
Inventory, Payment, Notification; `PAYMENT_WEBHOOK_SECRET` (required, no default) in Payment;
`REFRESH_GRACE_MS` (10 000) and `IDENTITY_KEYS` in Identity; `JWKS_URL` +
`JWKS_TTL_MS` (600 000) in the gateway.

`PAYMENT_WEBHOOK_SECRET` has **no default** on purpose — a default secret is not a secret, and
a service that cannot verify its webhook should refuse to boot.

## E. Design decisions (resolved)

| # | Decision | Why |
|---|---|---|
| 1 | Debt slice first, whole backlog in one pass | User choice. Later slices instrument a codebase with no known-red tests and no open security holes. |
| 2 | `hello` kept as a documented canary | Cheapest full-stack smoke test in the repo; catches shared-package regressions early. |
| 3 | Fail-fast kept; in-process reconnect **closed, not deferred** | The restart contract is tested and recovers in ~1s. Reconnect would rebuild consumers, channels and the relay lane against a contract that already works. |
| 4 | Retention via a shared periodic pruner over a port | Mirrors `startExpirySweeper`; keeps `@ecom/shared` free of any Prisma client; testable without a database. |
| 5 | Webhook HMAC over the raw body, timing-safe | Re-serialising `req.body` cannot reproduce the provider's bytes; `===` on a MAC leaks by timing. |
| 6 | `userId` required on `ChargePayment`, legacy rows read as unowned | Same widening pattern as Phase 5's `order.events`; a null-owner row 404s rather than leaking. |
| 7 | Grace window returns 401 without re-issuing the successor | Preserves the honest session without creating a second way to fork a family. |
| 8 | JWKS minimal: `kid` + two-key overlap, manual rotation | Automatic rotation is a phase on its own; `kid` + a cache is what makes rotation *possible*. |
| 9 | CI matrix over per-service steps | 7 near-identical steps is where copy-paste drift starts; 7b/7c add more services. |
| 10 | JWKS ordered last | The largest item; droppable without touching anything above it. |
| 11 | Comment deletion stays ADMIN-only | `Comment` records no author, so "delete your own" does not exist. Deletion is moderation; adding authorship is a feature, and this slice is debt. |
| 12 | Five tracked items explicitly out (§Scope) | A DoD claiming "the backlog reaches zero" is only checkable if the exclusions are named. |

## F. Known limitations (intentional)

1. **A poisoned reservation is retried every sweep** and only a log line reports it (§A1). A
   dead-letter status for reservations is a later call.
2. **Webhook verification is not replay protection** (§C1) — idempotency already makes a
   replay a no-op; timestamp + nonce deferred.
3. **The grace window narrows reuse-detection by 10s** (§C3), deliberately.
4. **Key rotation is manual** (§C4) — no automatic rollover, no revocation list.
5. **In-flight `ChargePayment` commands are rejected across the deploy** (§C2); the DLQ
   replay path is the remedy and the demo stack is disposable.
6. **Pruning is best-effort:** a service that never runs (or a stopped stack) prunes nothing.

## Testing (TDD)

Every group starts from a failing test:

- **Sweeper (int):** a batch containing one poisoned order (reservation whose `Inventory` row
  was deleted) still sweeps the healthy orders and returns their count — this is the assertion
  that turns the 2 currently-failing tests green.
- **Transition CAS (unit):** `applyResult` returns `NO_OP` and emits nothing when the CAS
  reports 0 rows; the happy path is unchanged.
- **Catalog lock (int):** two concurrent price updates produce exactly two `price_changed`
  rows with increasing versions, never one or three.
- **Pruner (unit + int):** rows older than the cutoff are deleted, rows inside it survive; the
  timer stops on shutdown.
- **Webhook HMAC (unit + int):** unsigned → 401, wrong signature → 401, valid → 200, and the
  rejection happens before any lookup (no `Payment` row is touched).
- **Payments ownership (int):** the owner reads their payment; another user gets 404; a legacy
  `userId: null` row gets 404.
- **Grace window (int):** a double-submit inside the window returns 401 with the family
  intact and the successor still usable; the same replay after the window revokes the family.
- **JWKS (int):** the gateway verifies a token whose `kid` is in the published JWKS; an
  unknown `kid` is 401 after one refresh attempt; a token signed by a retired-but-listed key
  still verifies.
- **Regression gate:** every service suite with its own `DATABASE_URL`, `pnpm -r typecheck`,
  `pnpm format:check`. **The gate for this slice is a fully green suite** — the 2 sweeper
  failures are no longer an accepted exception.

## Definition of Done

The whole suite is green with no accepted exceptions; an unsigned webhook cannot finalize a
payment; `GET /payments/:orderId` is scoped and re-proxied through the gateway; `ProcessedEvent`
and `RefreshToken` are bounded; catalog's dead table is gone; a concurrent refresh no longer
logs a user out; the gateway verifies tokens by `kid` from identity's JWKS; the CI integration
job is one matrix step; the roadmap's backlog-absorption map has no unclaimed Phase-7 rows
left except those explicitly assigned to 7b/7c/7d **and the five named in §Scope-out**.

## Open questions

None blocking. Deferred by decision: reservation dead-lettering, webhook replay protection,
automatic key rotation, discount projection into Order.
