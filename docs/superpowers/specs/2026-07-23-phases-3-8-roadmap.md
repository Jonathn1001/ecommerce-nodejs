# Phases 3–8 · Milestone Roadmap

> Addendum to the umbrella [`2026-07-18-microservices-streaming-rebuild-design.md`](./2026-07-18-microservices-streaming-rebuild-design.md).
> Phases 0–2b are complete (platform, Inventory, Order write-side + reserve-leg; saga
> currently stops at `AWAITING_PAYMENT`). This roadmap fixes the slicing, dependency
> edges, risks, and parked decisions for everything left. It re-decides **no**
> architecture — the umbrella's locked decisions stand (Kafka = events, RabbitMQ =
> commands, Redis = cache/lock/idempotency; DB-per-service; payment simulated; no
> cloud). Each phase still gets its own child spec → review → plan → execution cycle;
> each slice below = one such cycle (the 2a/2b pattern).
>
> Sizing unit: **Phase 2b = M**. Build order (serial policy): **3 → 4 → 5 → 6 → 7 → 8**.

## Grounding (verified against code, 2026-07-23)

- `packages/shared/src/rabbitmq.ts` exists (`assertWorkQueue` creating `${queue}.dlx`/`.dlq`, `sendCommand`, `consumeCommands`) but has **no retry layer** — one handler throw → `nack` straight to DLQ — and `sendCommand(queue, envelope)` is **not `ProducerPort`-compatible**, so the outbox relay cannot drive RabbitMQ without an adapter. No service uses RabbitMQ yet.
- **Cross-service gap:** nothing consumes a future `order.confirmed` on the Inventory side. Reservations only know `ACTIVE`/`RELEASED`; the TTL sweeper releases expired `ACTIVE` rows — so a confirmed order's stock would be re-sold. A `CONSUMED` status must land with the first `CONFIRMED` transition (Phase 3).
- Legacy email/notification is a **stub** (no mail transport dependency exists at all; template substitution unimplemented) → Phase 5 is greenfield in all but the type→content mapping.
- Legacy auth crypto is misleading: "publicKey/privateKey" are two random 64-byte hex strings used as per-user **HS256 symmetric** secrets; identity comes from an `x-client-id` header. Phase 6 **replaces** the scheme, preserving only the *behavior* (refresh rotation + reuse-detection).
- Legacy catalog factory stores each product in **two collections sharing one `_id`** (base + type-specific, no discriminators); legacy comments use a nested-set model with known insert bugs. Phase 4 collapses to one table + typed JSONB and re-derives the tree model.
- Deferred backlog to absorb: kafka envelope-parse outside try/catch (malformed envelope bypasses DLQ, stalls the partition), trace propagation HTTP-inbound-only, `ProcessedEvent` retention, no `/metrics` anywhere.
- **Platform constraint (permanent, don't rediscover per phase):** each service's `db.ts` loads its own env file into the shared `process.env.DATABASE_URL`, so two services can never run in one Vitest process — cross-service e2e is done over the wire against compose-run services (as 2b's e2e does), never in-process. Phase 7's chaos/e2e work depends on that mitigation.

---

## Phase 3 — Payment (saga completion) — **XL**

The keystone phase: closes the saga loop, first production RabbitMQ use, touches three services (Payment new, Order, Inventory).

**Scope in:** `services/payment` (`payments`, `payment_attempts`, `outbox`, `processed_events`); simulated gateway (deterministic success/fail/timeout); consume `ChargePayment` (RabbitMQ), emit `payment.succeeded`/`payment.failed` → Kafka `payment.events` via outbox. Order payment-leg (widen `nextStatus`/`ApplyOutcome` — the Phase-2b narrow return type makes this a deliberate compile-time checkpoint). Inventory `CONSUMED` status. Contracts: `CHARGE_PAYMENT`, `PAYMENT_SUCCEEDED/FAILED/REFUNDED`, `ORDER_CONFIRMED`. Order SSE endpoint (3c).
**Scope out:** real provider; refund *flow* beyond an admin-triggered `payment.refunded` stub; auth on any endpoint.

**Slices**
1. **3a — Payment service standalone.** Rabbit consumer on queue `payment.charge`, simulated gateway (sync success/fail only), payments + attempts, outbox → `payment.events`. Driven by hand-sent commands (exactly how Inventory ran before Order existed). **Absorbs platform work:** bounded retry for `consumeCommands` (today one throw → DLQ) and command idempotency (`processed_events` dedup + unique `payments.order_id` as the provider idempotency key).
2. **3b — Order payment-leg + atomic command emission.** Outbox→Rabbit **command-relay adapter**; Order enqueues `ChargePayment` in the same tx as the `AWAITING_PAYMENT` write (kills the dual-write); consumes `payment.events` → `CONFIRMED` (emit `order.confirmed`) / `CANCELLED`; **Inventory consumes `order.confirmed` → reservations `CONSUMED`** (sweeper releases only `ACTIVE` — closes the oversell gap); revisit `RESERVATION_TTL_MS` vs saga duration (the Phase-1 forward note comes due). **Folds in the shared kafka envelope-parse fix** — first phase where a stalled partition halts the money path.
3. **3c — SSE + async path.** `GET /orders/:id/stream` (one frame per transition), simulated-provider webhook resolving the "timeout" outcome asynchronously, admin refund stub emitting `payment.refunded`.

**Risks (ranked)**
1. Dual-write on RESERVED→ChargePayment → outbox command relay (child spec designs the routing).
2. Confirm-after-release race (payment succeeds after TTL; sweeper already released) → `CONSUMED` lands in the *same slice* that first produces `CONFIRMED`; child spec resolves the TTL race (order-side auto-cancel at expiry vs TTL ≫ saga p99).
3. No Rabbit retry → transient DB blip mis-classified as poison; fix in 3a before real traffic.
4. Exactly-once charging under redelivery → ledger + unique constraint + forced-redelivery test.
5. Timeout/webhook scope creep → quarantined to 3c; clock-injectable gateway.

**Parked for child specs:** command-relay mechanics (outbox transport column vs `aggregateType`→transport map vs second table); Rabbit retry pattern (in-handler backoff vs TTL retry queue); deterministic-gateway encoding (how the payload selects success/fail/timeout); TTL-race resolution; naming (`payment.charge`, `payment.events`, partition key = orderId); SSE transition-observation mechanism (in-process off the consumer vs Postgres LISTEN/NOTIFY vs poll); refund stub scope.

**📌 SSE placement decision: slice 3c, not Phase 6.** This **amends the umbrella's Phase-2 row** (which promised the SSE stream in Phase 2; slices 2a/2b deferred it as a forward dependency). Only after Phase 3 does the state machine emit every transition worth streaming; building the endpoint beside `transition.ts` in the same worktree avoids a cross-phase seam. Phase 6 then carries only its genuinely-new risk (proxying a stream).

**Done when:** place order → `PENDING → AWAITING_PAYMENT → CONFIRMED` with reservation `CONSUMED`; forced failure → `CANCELLED` + stock released; SSE streams every transition; a poison `ChargePayment` demonstrably lands in `payment.charge.dlq`.

---

## Phase 4 — Catalog — **L**

**Scope in:** `services/catalog` — products as **one table + per-type zod-validated JSONB attributes** (collapse the legacy shared-`_id` factory); comments (**re-derived** tree model — not the buggy nested-set); discounts (CRUD + `getDiscountAmount` rules: max-use, per-user, min-order, expiry — service-local); outbox → Kafka `catalog.events`. Contracts: `catalog.product_created/product_updated/price_changed`. Order: replace the 2a `POST /admin/catalog` seed with a `catalog.events` projection.
**Scope out:** discounts in checkout pricing (decision below), media upload, search.

**Slices**
1. **4a — Catalog core + events:** products CRUD, price change → `price_changed`, outbox, admin HTTP. Standalone demo.
2. **4b — Order projection:** consume `catalog.events` → **version-guarded** idempotent upsert into `catalog_read_model`; admin-seed endpoint fate; bootstrap/replay story for pre-projection data.
3. **4c — Comments + discounts:** re-derived comment tree (adjacency list or materialized path) + discount rules.

**Risks:** out-of-order/duplicate `price_changed` corrupting checkout prices (version/timestamp guard, property-tested); comment-tree re-derivation correctness (property tests on insert/move/delete); type-collapse behavior loss (golden tests from legacy factory samples); read-model bootstrap (replay-from-earliest vs snapshot).

**Parked for child specs:** comment tree model; where JSONB attribute schemas live (contracts vs catalog-local); `price_changed` emission granularity; bootstrap mechanism; admin-seed fate; discount-usage tracking tables.

**📌 Discounts-in-checkout decision: NO for this pass.** Order keeps pricing from its local `catalog_read_model` untouched (the umbrella's locked local-pricing invariant). "Discount projection into Order" is a named backlog item, not silent scope.

**Done when:** create/update product in Catalog → appears in Order's read model with correct price → a new order prices from it, no admin seed involved; comments + discounts work service-locally.

---

## Phase 5 — Notification — **M**

Effectively greenfield (legacy is a stub). The **RabbitMQ showcase** phase.

**Scope in:** `services/notification` (`notifications` table); Kafka consumer on `order.events` (placed/confirmed/cancelled) → notification row + `SendEmail` command via the **Phase-3 outbox→Rabbit adapter** to queue `notifications` (umbrella's `notifications.dlx` naming); worker: nodemailer → **mailpit** (new compose service); minimal template rendering; port only the legacy type→content mapping + schemas. **DLQ replay documented AND demoed** — the phase's headline lesson.
**Scope out:** real provider, push, OTP (ownership decided in Phase 6 if Identity wants verification email), catalog-event notifications (stub the subscription).

**Slices**
1. **5a — Dispatcher:** `order.events` → notification rows + `SendEmail` commands; idempotent on both legs (Kafka `eventId` ledger + unique `(orderId, type)` row).
2. **5b — Worker + mailpit:** consume queue, render, send; retry/backoff reused from Phase 3; poison → `notifications.dlq`; replay script + runbook. **Harden the rabbit adapter FIRST** (before this second consumer/producer inherits its gaps — surfaced by the Phase-3a and Phase-3b whole-branch reviews): (a) **consumer reconnection** — after a real broker drop `checkHealth` flips unready but nothing re-establishes the consumer, so the command intake silently stalls; add reconnect (or document a liveness-restart contract); (b) **`ch.prefetch()`** back-pressure — no prefetch today means unbounded unacked in-flight (Payment survives via unique-`orderId`+retry, but a worker fleet wants bounded concurrency); (c) **sender/command-lane recovery + boot-time retry** (3b review) — Order's `main.ts` does `await createRabbit()` before the HTTP server starts (a boot-time Rabbit outage prevents Order serving at all), and `createRabbit` has no reconnect, so a mid-life drop permanently wedges the command lane (`outbox_lane_failed` every tick, rows pile up) until restart. The "outbox buffers rabbit outages" property holds only for a live process; add boot-time retry (non-fatal, degrade to buffering) + command-lane re-establish so the relay recovers without a restart.

**Hard dependency:** Phase 3 (`order.confirmed` exists; rabbit adapter + retry reused, not rebuilt — plus the 5b `consumeCommands` hardening above). Soft on Phase 4 (product names in emails — degrade gracefully).

**Risks:** duplicate emails — at-least-once on *both* legs → dispatcher dedup AND worker sent-marker; PII in logs — log notification id/type, never recipient or rendered body; replay ergonomics — make the DLQ replay the demo, not an afterthought.

**Parked for child specs:** transport port abstraction vs direct nodemailer; template mechanism (lean: template literals); OTP ownership; queue topology (single `notifications` queue vs per-type routing keys); **dedup pattern choice** — Postgres `ProcessedEvent` ledger (same-tx, as Order/Inventory) vs the unused Redis `markProcessed` helper (`packages/shared/src/redis.ts`) — pick deliberately and add a when-to-use-which note to `shared` (two mechanisms with zero guidance is compounding debt).

**Done when:** the saga produces an order-confirmed email visible in the mailpit UI; a poisoned `SendEmail` lands in `notifications.dlq` and is replayed to success via the documented procedure.

---

## Phase 6 — Identity + Gateway — **L**

**Scope in:** `services/identity` — signup/login/logout/refresh with **rotation + reuse-detection preserved as behavior** (legacy-derived tests written first); token crypto **replaced** (identity from token claims, never `x-client-id`); `users`/`key_tokens`/`roles`/`resources`/`grants`; `identity.user_registered` → Kafka. `services/gateway` — **no DB, no business logic**: routing, JWT verify, **httpOnly Secure SameSite cookie** set/refresh, CSRF double-submit on mutations, rate-limit + helmet, traceId minting, **timeouts + circuit breaker on all proxied routes** (umbrella §Resilience — the gateway is the sole sync service-call edge, so this lands here or nowhere), **SSE proxy** for the 3c stream. RBAC **enforcement built fresh** (legacy grants model was never consumed by any middleware; the hardcoded accesscontrol file is dead) — a minimal matrix, not a framework. **Identity-propagation retrofit:** existing services stop trusting raw client headers (`x-user-id` in Order's cart/order routes — 2a Known-limitation #4; Catalog's admin surface by then) — the gateway injects verified identity, services consume it, and every int/e2e test that sets the header migrates. Real multi-service work; scoped here explicitly so it cannot hide inside "gateway".
**Scope out:** OAuth/social; api_keys port (parked); admin UI.

**Slices**
1. **6a — Identity standalone:** behavior tests from legacy flows first, then implementation; JWT issuance; RBAC data model + grant admin; `user_registered` (optional welcome-email cross-check with Phase 5).
2. **6b — Gateway:** proxy (with per-route timeouts + circuit breaker) + cookie/CSRF + rate-limit + RBAC enforcement + SSE proxy + the identity-propagation retrofit across existing services; e2e browser-style flow through the gateway into Order/Catalog.

**Risks:** crypto replacement silently breaking rotation/reuse-detection semantics → behavior-first TDD; SSE through a proxy (buffering, idle timeouts, cookie-on-EventSource) → integration test streams a *real* saga with heartbeats; cookie/CSRF matrix on local http (`Secure` only in prod compose profile, documented); RBAC scope creep → fix a minimal matrix (admin catalog mutations, order ownership) and stop.

**Parked for child specs:** JWT algorithm (**RS256 recommended** — gateway verifies with a public key, no shared secret) + TTLs; enforcement placement (gateway-only vs gateway+service); circuit-breaker policy + library (gateway edge only — broker paths already have `withRetry`); identity-propagation mechanism (trusted internal header signed/injected by gateway vs re-verified JWT per service); api_keys port-or-drop; proxy implementation (`http-proxy-middleware` vs hand-rolled); CSRF mechanics; refresh-token storage shape in Postgres.

**Done when:** register → login → cookie set → full browse/cart/checkout through the gateway only; order stream live over proxied SSE; an unauthorized admin mutation rejected by RBAC; service ports closed to direct access in the prod compose profile.

---

## Phase 7 — Hardening & verification — **XL**

**Scope in:** `/metrics` via a prom-client module in `packages/shared` (sibling to `health.ts`); RED + domain metrics (consumer lag, DLQ depth, saga-step latency, reservation conflicts); Prometheus + Grafana + Jaeger compose additions; dashboards + SLO burn alerts in `infra/`. OpenTelemetry traces — **absorbs the trace-propagation backlog wholesale** (AsyncLocalStorage context, consumer-side traceId auto-logging, envelope→span linkage). k6 checkout load vs SLOs (p95 < 500 ms, saga p99 < 5 s, error < 1 %); chaos suite (kill broker/service mid-saga; malformed-envelope case proving the 3b parse fix); **ProcessedEvent retention** (landed in 7a via `startLedgerPruner`); runbooks. Umbrella-locked lessons: orchestrated-saga comparison variant + schema-evolution `v1→v2` event — **both deferred out of Phase 7, see the backlog row**.
**Scope out:** Debezium/logical-decoding outbox upgrade (umbrella-optional — stretch), cloud anything.

**Slices:** **7a** correctness & hygiene debt (done, merged) → **7b** metrics + dashboards → **7c** OTel/Jaeger + trace context → **7d** verification: k6 + chaos + SLO alerts + runbooks. Retention is NOT in 7d — it landed in 7a. Neither are the two umbrella-locked lessons, which now carry their own backlog row so they are deferred visibly rather than quietly dropped from a slice line nobody re-reads. SLO burn alerts sit in **7d**, not 7b — burn-rate rules can only be validated against k6 load, and an untested alert is decoration. 7a absorbed the test/CI hygiene debt that this line previously deferred: the periodic e2e-topic reset (durable `inventory.events` replays grew every dev/CI run) and the **CI integration-job matrix refactor** both landed there, and the **hello service's fate** was decided rather than defaulted — kept as a deliberate canary.

**Risks:** instrumentation is a wide mechanical diff across 6+ services → build once in `packages/shared`, adopt per service as separate small tasks; chaos flakiness → nightly/local lane, never per-push CI; orchestrated-saga variant scope explosion → confine to a module + comparison doc.

**Parked for child specs:** OTel auto- vs manual instrumentation; consumer-lag metric source; retention windows; k6 thresholds; Debezium stretch go/no-go.

**Done when:** one Grafana dashboard shows a full checkout's RED + saga metrics; one Jaeger trace spans gateway→order→inventory→payment→notification; k6 meets the SLOs; killing Kafka mid-saga recovers with zero lost or double effects.

---

## Phase 8 — Storefront — **L**

Per the umbrella's §Phase 8 design (stack, flows, design language, DoD locked there).

**Slices**
1. **8a — Foundation + catalogue:** `apps/*` into `pnpm-workspace.yaml` with
   `packages/contracts` consumed as TypeScript source (**the dual ESM+CJS build originally
   specified here was withdrawn in 8a — see that child spec §A1**); `apps/web` (Vite + React
   + TS + Tailwind); gateway client with zod boundary validation, reaching the gateway over a
   same-origin **`/api/*`** prefix the dev proxy strips, with **Catalog asserting its own
   responses against the shared schemas**; home/product views with loading/error/empty
   states. Stock is **not** shown — it lives in Inventory, which the gateway does not mount.
2. **8b — Auth + cart + checkout:** cookie login/register through the gateway (register returns
   no tokens, so it lands on a prefilled sign-in), CSRF on every mutation, protected routes with
   a return-to, the server cart joined against the catalogue for names, and place order. The
   session is derived from `GET /cart`, **not** from the readable CSRF cookie — that cookie
   outlives an expired refresh token, and refreshing on an anonymous 401 would bounce a visitor
   off the public catalogue. Frontend only: no service production code changed.
3. **8c — Order-pipeline tracker + polish:** SSE tracker (the signature element, per the approved prototype), polling fallback, order history, a11y + `prefers-reduced-motion`, Playwright e2e, Dockerfile + prod profile.

**Risks:** ~~dual-build breaking the consuming services~~ — withdrawn in 8a, so the risk is
gone with it; instead, contracts drifting from what Catalog actually serves → **Catalog
asserts its own responses against the shared schemas**, so drift fails a backend test beside
the change that caused it; EventSource + cookie via proxy → de-risked in 6b, verify the
fallback; tracker design bar → prototype is the reference, component tests per saga-state
rendering.

**Parked for child specs:** React 18 vs 19 (umbrella: latest at build time); SSE frame DTO shape in contracts; Playwright in CI vs local-only. Note: the CI `quality` job auto-globs only `services/*` — `apps/web` needs hand-wiring + a Playwright lane.

**Done when:** browse → cart → login → checkout in a browser; the tracker animates `PENDING → reserved → paid → CONFIRMED` live and shows the compensation path on a forced payment failure; Playwright e2e green.

---

## Critical path — why 3 → 4 → 5 → 6 → 7 → 8

Serial per policy. The only theoretically parallelizable pair is **3 ∥ 4** (near-disjoint services) — rejected: both modify the Order service (payment-leg vs projection = merge contention across worktrees), and Phase 3 completes the saga, behind which sit 3c-SSE, Phase 5 (hard dependency on `order.confirmed` + the rabbit adapter/retry), Phase 7 (the SLOs are saga SLOs), and Phase 8 (the tracker). The second temptation — 5 before 4 — buys nothing under serial policy and ships emails without product data. 6 must follow the services it fronts; 7 needs the whole system to harden; 8 needs 6.

## Backlog absorption map

| Item | Absorbed by |
|---|---|
| Rabbit retry layer + outbox→command adapter | **3** (3a / 3b) |
| Rabbit consumer reconnection + `ch.prefetch()` back-pressure (from 3a review) | **5** (5b — harden the rabbit adapter before the SendEmail worker) |
| Rabbit sender/command-lane recovery + boot-time retry (from 3b review) | **5** (5b(c) — same rabbit-adapter hardening pass) |
| Order SSE `pg` LISTEN client in-process reconnect (fail-fast process-restart today; a PG drop briefly drops all streams) — from 3c review | **5** (resilience pass, sibling to the rabbit-adapter hardening) |
| Split `SubscriberRegistry` into its own file (unit test imports `pg` transitively) + SSE 404-test error/timeout guard — from 3c review | split **landed** (`services/order/src/sse-registry.ts`); the 404-test guard is next-touch. Not 7d — that slice is verification only |
| Catalog `productTx.loadForUpdate` → real `SELECT … FOR UPDATE` (today a plain findUnique; concurrent price PATCHes can suppress/dup a `price_changed`) — from 4 review | **landed** — `services/catalog/src/tx-adapters.ts:22` is a bound-param `FOR UPDATE`, regression-guarded by `price-lock.int.test.ts`'s same-new-price case |
| Drop the dead `ProcessedEvent` table from catalog's schema (scaffold copy-paste; catalog consumes nothing) — from 4 review | **landed** — no `ProcessedEvent` model remains in `services/catalog/prisma/schema.prisma` |
| Order status-guard `setStatus` compare-and-set — read-then-write w/o row lock; two distinct events for one order could both read `AWAITING_PAYMENT` and emit contradictory terminal events. Unreachable today (Payment emits exactly one deterministic result per order; single consumer group serial per partition) but 3b raised the stakes (from 3b review) | **7** (7a — landed; `setStatus(orderId, status, expected)` is a CAS returning `false` on a lost race) |
| Inventory `sweepOnce()` per-order isolation — one order's failure aborts the whole batch (same class Task 3 fixed for the relay tick); latent Phase-3a bug surfaced by the 3b regression gate on stale dev-DB rows | **7** (7a — landed; `sweepOnce()` wraps each order in its own try/catch) |
| 3b-review minor polish — `outbox.ts` `queueFor` compute-once; `kafka.ts` restore `eventId` key+log on the retry-exhausted DLQ path; `ORDER_CONFIRMED` const grouping; payment-leg e2e assert `payload.orderId` + tighten teardown race | first two **landed** (`outbox.ts:141` calls `queueFor` once per row per tick; `kafka.ts` parks with `key: eventId` and logs it); remaining two opportunistic. Not 7d — verification only |
| Kafka envelope-parse DLQ-bypass fix (`packages/shared/src/kafka.ts`) | **3** (3b) |
| Trace propagation (AsyncLocalStorage, consumer-side traceId) | **7** (subsumed by OTel) |
| `ProcessedEvent` retention | **7** (7a — landed via Task 4's `startLedgerPruner`) |
| Umbrella-locked lessons: orchestrated-saga comparison variant + schema-evolution `v1→v2` event | named backlog (deferred out of **7d**, unscheduled) — each is a teaching exercise in its own right, not verification work, and bundling them into the verification slice was what kept them invisible |
| `/metrics` + prom-client module | **7** (7b) |
| Compose: mailpit | **5** |
| Compose: prometheus / grafana / jaeger | **7** |
| Per-service compose `app` entries + hand-added CI integration steps | every phase (part of its DoD) |
| ~~Contracts dual ESM+CJS build~~ — **withdrawn in 8a**; contracts stays TypeScript source | — |
| Gateway timeouts + circuit breaker (umbrella §Resilience) | **6** (6b) |
| `x-user-id` → verified-identity retrofit across existing services | **6** (6b) |
| Dedup-pattern guidance in `shared` (ProcessedEvent vs Redis `markProcessed`) | **5** (5a decides + documents) |
| e2e durable-topic reset · CI matrix refactor | **7** (7a — landed via Task 11) |
| hello-service fate | decided: kept as canary (7a) |
| Discount projection into Order's read model | named backlog (post-4, unscheduled) |
| Stale repo `CLAUDE.md` (still describes the legacy MVC/MongoDB app — misleads every agent session) | **landed** (2026-08-06) — rewritten against the tree at `e4001dc`: monorepo identity, the `prisma generate` prerequisite, vitest's substring-not-glob filter, the locked broker roles, the saga/outbox/gateway-allowlist patterns, and the traps that cost real time (one `DATABASE_URL` per Vitest process, no volume mounts on service containers, local compose drift). Every line of the old file described `legacy/` |

## Relative sizes

**3 = XL · 4 = L · 5 = M · 6 = L · 7 = XL · 8 = L** (unit: Phase 2b = M).

## Next action

Phase 3 brainstorm → child spec for **slice 3a** (Payment service standalone), agenda = Phase 3's parked-decision list above.
