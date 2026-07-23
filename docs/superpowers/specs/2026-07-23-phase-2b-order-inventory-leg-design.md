# Phase 2b · Order (Inventory-leg consumer) — Design (child spec)

> Child spec of the umbrella [`2026-07-18-microservices-streaming-rebuild-design.md`](./2026-07-18-microservices-streaming-rebuild-design.md).
> Continues [`2026-07-22-phase-2-order-foundation-design.md`](./2026-07-22-phase-2-order-foundation-design.md) (Phase 2a, write-side foundation — complete).
> This spec designs the **reserve-leg** of Order's saga participation: its first Kafka
> consumer, the first real state transitions, and the idempotency ledger every later
> Order consumer reuses. It stops honestly at `AWAITING_PAYMENT`; Payment (Phase 3)
> closes the loop.

## Purpose

Phase 2a stood up Order's write side: a cart, a local price projection, and a
`placeOrder` that writes `PENDING` + an `OrderPlaced` event to the outbox in one
transaction. Order emits, but is **deaf to results** — it has no consumer, no state
transitions, and no idempotency ledger. Inventory reserves against `OrderPlaced`,
then its sweeper auto-releases after the TTL because Order never confirms (2a's
"stranded reservation" known limitation).

This slice makes Order **react** to Inventory's reservation result and drive its first
transitions:

- `INVENTORY_RESERVED` → `PENDING → AWAITING_PAYMENT`.
- `INVENTORY_RESERVATION_FAILED` → `PENDING → CANCELLED`, emitting `OrderCancelled`.

It is the "reserve-leg" branch of the fork the 2a spec parked (`reserve-leg /
full-state-machine / payment-stub`). Payment does not exist yet, so the slice stops at
`AWAITING_PAYMENT` — an honest boundary with **no throwaway stubs** (umbrella decision
#11). Following the Phase-1/2a precedent it is still an independently runnable,
demoable slice: with the live Inventory service running, `POST /orders` now drives a
real reservation **and** a real Order transition end-to-end.

## Scope

**In:**
- **Kafka consumer** on `inventory.events`, consumer group `order-consumers`, dispatching on
  event type — `INVENTORY_RESERVED`, `INVENTORY_RESERVATION_FAILED`; any other type on
  the topic is ignored (no-op, never DLQ). Mirrors Inventory's `order.events` consumer.
- **Order state machine** — a pure `transition.ts` core (transition table +
  `canTransition`/`nextStatus`), unit-tested. Reachable states this slice:
  `PENDING`, `AWAITING_PAYMENT`, `CANCELLED`. `CONFIRMED` stays unreachable (Phase 3).
- **`ProcessedEvent` idempotency ledger** — a new Postgres table; dedup-on-`eventId`
  checked **and** written in the same transaction as the transition. The canonical
  at-least-once dedup pattern (umbrella §Idempotency), reused by every later Order
  consumer (payment results, catalog projection).
- **`OrderCancelled` emit** — on the `→ CANCELLED` transition, an `ORDER_CANCELLED`
  outbox row written in the same transaction (reuses the existing `Outbox` + relay).
  This slice's single instance of transactional-outbox-**from-a-consumer**.
- `GET /orders/:id` now observably reports `AWAITING_PAYMENT` / `CANCELLED`.
- Per-service Definition of Done maintained: the consumer joins graceful shutdown.
  `/readyz` is unchanged (probes Postgres only) — see the note under Configuration.

**Out (deferred — YAGNI):**
- `ChargePayment` (RabbitMQ command), payment-result handling, `OrderConfirmed`, and
  the `CONFIRMED` path — Phase 3 (Payment).
- Live catalog projection (`PriceChanged`/`ProductCreated` consumer) and
  `contracts/events/catalog.ts` — Phase 4 (Catalog).
- **SSE** `GET /orders/:id/stream` — forward dependency on the Gateway (umbrella
  §Sync read surface, Phase 6).
- Real auth — `x-user-id` header remains the temporary stand-in.
- Any contract change — none is needed (see Contracts).

## Order status model

Target lifecycle for the whole saga: `PENDING → AWAITING_PAYMENT → CONFIRMED`, with
`CANCELLED` as the compensation terminal. **2a implemented only `PENDING`.** This slice
adds the first transitions out of `PENDING` and makes `AWAITING_PAYMENT` and
`CANCELLED` reachable. `CONFIRMED` and the `AWAITING_PAYMENT → CONFIRMED` /
`AWAITING_PAYMENT → CANCELLED` (payment-driven) transitions land in Phase 3, tested
against the payment events that cause them.

Transition table (this slice):

| Current | Event | Next |
|---|---|---|
| `PENDING` | `INVENTORY_RESERVED` | `AWAITING_PAYMENT` |
| `PENDING` | `INVENTORY_RESERVATION_FAILED` | `CANCELLED` |
| any other (status, event) | — | `null` (no-op guard) |

`nextStatus(current, eventType)` returns the next status or `null` when the transition
is not defined. `null` is the guard for a late, duplicate, or out-of-order event (e.g.
`INVENTORY_RESERVED` arriving after the order is already `CANCELLED`).

## Consumer flow (one transaction per event)

The consumer mirrors `services/inventory/src/consumer.ts`: a thin orchestrator that
parses the envelope, opens one `prisma.$transaction`, and calls the pure core over a
tx-bound port. The transition decision itself is the pure core (`transition.ts`).

```
handleInventoryEvent(env):
  if env.type not in { INVENTORY_RESERVED, INVENTORY_RESERVATION_FAILED }:
    return                                             -- not ours; no-op, no DLQ
  payload = parse(env.payload)                         -- both payloads carry orderId
  return prisma.$transaction(tx =>
    status = tx.loadOrderStatus(payload.orderId)
    if status is null:
      return "UNKNOWN_ORDER"                           -- log + ack; NOT ledgered (replay-safe)
    if tx.processedEvent.exists(env.eventId):
      return "DUPLICATE"                               -- dedup: redelivery
    tx.processedEvent.insert(env.eventId, env.type)
    next = nextStatus(status, env.type)                -- pure core
    if next is null:
      return "NO_OP"                                   -- guard: late/out-of-order (still ledgered)
    tx.setStatus(payload.orderId, next)
    if next == "CANCELLED":
      tx.enqueue(ORDER_CANCELLED, payload.orderId, { orderId: payload.orderId })
    return next
  )
```

**Order of operations is load-bearing:** the order is loaded **before** the ledger is
touched. An event whose `orderId` has no row (`UNKNOWN_ORDER`) is acked *without* a
`ProcessedEvent` row, so a later replay — once the order materializes — can still apply
the transition (keeps Known-limitation #3's replay path honest). A duplicate or
out-of-order event *for a known order* is still ledgered / status-guarded as normal.

**Idempotency is belt-and-suspenders:**
- The `ProcessedEvent` primary key (`eventId`) stops any *re-effect* on redelivery —
  the whole handler, including the `OrderCancelled` emit, runs at most once per event.
- The status guard (`nextStatus` → `null`) independently stops any *invalid* or
  *out-of-order* transition, regardless of dedup.

Both the ledger insert, the status change, and the outbox row commit in **one**
transaction, so the effect is exactly-once even across a crash between steps.

**Why emit `OrderCancelled` when nothing was reserved.** A reservation *failure* means
Inventory holds nothing for this order, so no stock compensation is strictly required.
Order still emits `ORDER_CANCELLED` because it is the order's own lifecycle fact:
it gives a uniform lifecycle for Notification (Phase 5) to consume, and it exercises
transactional-outbox-from-a-consumer here rather than deferring the pattern. It is
safe: Inventory's `releaseForCancel` is guarded on `status = ACTIVE`, so with nothing
reserved the consume is a no-op and emits nothing further (no event loop).

## Data model (Postgres `order` database)

One additive migration via `prisma migrate dev` (CLI only; never hand-edited).
Convention as established: PascalCase models, camelCase fields, no `@map`.

- **New — `model ProcessedEvent { eventId String @id; type String; processedAt DateTime @default(now()) }`**
  — the dedup ledger. `eventId` is the envelope id; `type` is retained for debugging /
  future replay tooling. No index beyond the primary key (lookups are by `eventId`).
  Adding a brand-new table is trivially **expand/contract-safe** (the umbrella
  Per-service DoD) — no existing column is altered, so it is a pure additive migration.
  **Retention:** the ledger grows unbounded this slice — no pruning/TTL. Acceptable for
  the learning scope; bounding it (periodic prune by `processedAt`, or the umbrella's
  Redis `SET NX` + TTL alternative) is deferred future work, not built here.
- **Reused unchanged — `Order`** (`status` is a string; new values `AWAITING_PAYMENT`,
  `CANCELLED` require no schema change), **`Outbox`** (the `ORDER_CANCELLED` emit reuses
  the exact shape from 2a / Inventory), `Cart`, `CartItem`, `OrderItem`,
  `CatalogReadModel`.

## Ports (`tx-adapters.ts`)

Add a `transitionTx(tx, traceId)` binding a `TransitionTx` port to one interactive
Prisma transaction client, `traceId` closured — the same style as the existing
`placeOrderTx`. Surface:

- `processedEvent.exists(eventId): Promise<boolean>`
- `processedEvent.insert(eventId, type): Promise<void>`
- `loadOrderStatus(orderId): Promise<string | null>`
- `setStatus(orderId, status): Promise<void>`
- `enqueue(type, orderId, payload): Promise<void>` — reuse the existing outbox writer.

The transition decision stays a transport-free pure core (`transition.ts`); the port
carries only persistence.

## Contracts (`packages/contracts`)

**No contract change.** The consumed schemas
(`InventoryReservedPayloadSchema`, `InventoryReservationFailedPayloadSchema`) and the
emitted `ORDER_CANCELLED` / `OrderCancelledPayloadSchema` already exist. Both inventory
payloads carry `orderId`, which is the correlation key back to Order's aggregate.

**Topics:** Order subscribes to `inventory.events` (Inventory is its sole producer,
Phase 1) and continues to produce on `order.events` (the `ORDER_CANCELLED` emit, drained
by the shared relay via `topicFor(aggregateType)`).

## Configuration & inherited Definition of Done

**No new env.** `ProcessedEvent` is a Postgres table, so idempotency needs no Redis;
this slice adds no lock and reuses the existing `KAFKA_BROKERS`. Config stays
`DATABASE_URL`, `KAFKA_BROKERS`, `PORT`, `LOG_LEVEL`.

- **`main.ts`** reuses the `createKafka("order")` instance →
  `createConsumer(kafka, "order-consumers")` → `consumer.connect()` →
  `consumer.run(["inventory.events"], handleInventoryEvent)`. The consumer joins
  `gracefulShutdown` (reverse teardown), matching Inventory's actual order: the HTTP
  server drains **first**, then `consumer.disconnect()` → `relay.stop()` →
  `producer.disconnect()` → `prisma.$disconnect()` last.
- **`/readyz`** is unchanged — `createHealthRouter({ db })`, Postgres only. This matches
  `services/inventory`, which probes `{ db, redis }` and deliberately does **not** probe
  Kafka in readiness (a lost consumer connection is handled by the shared retry +
  error-boundary, not by flipping the service unready). Order holds no Redis client, so
  it has no `redis` check either.
- Broker connect retry/backoff and the consumer error boundary are inherited from
  `@ecom/shared`. A throwing handler is **retried** (`withRetry`, `maxRetries` default
  3, exponential backoff — `kafka.ts`), then on exhaustion **parked to
  `inventory.events.dlq`** and committed so the partition keeps moving — never silently
  dropped. This is Order's inherited DLQ path for the umbrella DoD's "DLQ + replay
  documented"; a business no-op (`UNKNOWN_ORDER`/`DUPLICATE`/`NO_OP`) *returns* rather
  than throws, so it acks normally and never reaches the DLQ.
- Dockerfile, `app` compose profile, and CI are unchanged from 2a (the workspace CI
  already builds/lints/typechecks/tests every service).

## Known limitations (intentional, this slice)

1. **Strands at `AWAITING_PAYMENT`.** With no payment path, a reserved order sits at
   `AWAITING_PAYMENT` and Inventory's sweeper auto-releases its reservation after
   `RESERVATION_TTL_MS`. Same spirit as 2a's stranded-at-`PENDING`; the confirm path
   lands in Phase 3. The demo completes in seconds, well under the TTL.
2. **Phase-1 TTL forward note acknowledged, not yet binding.** The Inventory note
   (`RESERVATION_TTL_MS` must exceed the full saga duration or the sweeper releases
   legitimate in-flight orders) only bites once a confirm path exists to protect —
   Phase 3. Flagged so it is not forgotten.
3. **Unknown-order events are acked, not dead-lettered — and stay replay-recoverable.**
   An inventory event whose `orderId` has no matching Order row is logged and acked
   (`UNKNOWN_ORDER`) **without** a `ProcessedEvent` row, so if the order later
   materializes a replay of that event still applies the transition. Order emitted the
   originating `OrderPlaced`, so this should not occur outside a manual/replay scenario;
   acking (not throwing) avoids a poison-message stall, and skipping the ledger keeps
   the replay path open.
4. **`x-user-id` header auth.** Unchanged temporary stand-in until Gateway/Identity.

## Testing (TDD)

- **Unit** — `transition` core against the table: `(PENDING, RESERVED) →
  AWAITING_PAYMENT`; `(PENDING, FAILED) → CANCELLED`; every guard returns `null`
  (`AWAITING_PAYMENT`/`CANCELLED`/`CONFIRMED` as current, or an unrecognized event).
- **Integration** (compose stack — real Postgres + Kafka):
  - `INVENTORY_RESERVED` → `Order` goes `PENDING → AWAITING_PAYMENT`, one
    `ProcessedEvent` row, **no** outbox row.
  - `INVENTORY_RESERVATION_FAILED` → `PENDING → CANCELLED`, one `ProcessedEvent` row,
    **one** `ORDER_CANCELLED` outbox row (payload `{ orderId }`).
  - **Duplicate `eventId` redelivered** → second delivery is a no-op: status
    unchanged, no second outbox row, still one `ProcessedEvent` row (dedup proven).
  - Event for an unknown `orderId` → `UNKNOWN_ORDER`: acked, no throw, no state change,
    **and no `ProcessedEvent` row** (so a later replay after the order exists still
    transitions it).
  - Out-of-order guard: `INVENTORY_RESERVED` after the order is already `CANCELLED`
    → `null` no-op, status stays `CANCELLED`.
- **Slice e2e** (real Inventory service on the compose stack):
  - Happy: seed price + stock + cart → `POST /orders` → poll `GET /orders/:id` until
    `AWAITING_PAYMENT` (via the real reservation round-trip).
  - Fail: seed insufficient stock → order reaches `CANCELLED` and an `ORDER_CANCELLED`
    envelope is observed on `order.events`.

## Definition of Done

- Consumer live on `inventory.events`; the two transitions and the guard behave per the
  table; dedup proven by the duplicate-delivery test.
- `ProcessedEvent` ledger insert + status change + (`CANCELLED` only) `ORDER_CANCELLED`
  outbox row all commit in one transaction.
- `AWAITING_PAYMENT` / `CANCELLED` observable via `GET /orders/:id`.
- No contract change; no new env.
- Inherited DoD maintained: consumer in graceful shutdown (server-drain-first order);
  `/readyz` probes Postgres; Dockerfile + `app` compose profile + CI green.
- Unit + integration + slice-e2e tests green.

## Open questions

None blocking. Resolved in brainstorming on 2026-07-23: scope is the **reserve-leg**
branch of the 2a fork (no payment stub — honest stop at `AWAITING_PAYMENT`);
idempotency uses a **`ProcessedEvent` ledger** (canonical, reusable, same-tx) rather
than status-guard-only; Order **emits `OrderCancelled`** on the reservation-failed
cancel (uniform lifecycle + exercises outbox-from-consumer; safe via Inventory's
`status = ACTIVE` release guard).

Design review (review-design-plan, 2026-07-23) resolved: load the order **before**
touching the ledger so `UNKNOWN_ORDER` events stay **replay-recoverable** (not
ledgered); the inherited consumer error boundary retries then parks to
`inventory.events.dlq` (named as Order's DLQ path); `ProcessedEvent` retention is
deferred future work; the new-table migration is expand/contract-safe.
