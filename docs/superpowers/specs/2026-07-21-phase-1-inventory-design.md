# Phase 1 · Inventory — Design (child spec)

> Child spec of the umbrella [`2026-07-18-microservices-streaming-rebuild-design.md`](./2026-07-18-microservices-streaming-rebuild-design.md).
> Phase 0 (platform foundation) is complete; this spec designs the first domain service.

## Purpose

Stand up the **Inventory** service: the leaf the checkout saga depends on. It owns
its own Postgres database, reserves stock in response to `OrderPlaced`, releases it
on `OrderCancelled` or reservation expiry, and emits the results as domain events.
The Redis distributed lock (today in the legacy checkout) moves here, where
reservation concurrency belongs.

Inventory is built **before** Order (Phase 2), so it must be an independently
runnable, demoable slice: an HTTP admin surface seeds stock, and a hand-crafted
`OrderPlaced` published to Kafka drives a reservation end-to-end.

## Scope

**In:**
- HTTP admin surface — add/seed stock, query levels.
- Kafka consumer of `order.events` — `OrderPlaced` (reserve), `OrderCancelled` (release).
- All-or-nothing multi-item reservation in one Postgres transaction.
- Redis per-product distributed lock wrapping the reserve (the taught pattern).
- Transactional outbox → `inventory.events`, drained by the shared relay.
- Reservation **expiry sweeper** (auto-release stranded holds → `InventoryReleased`).
- Atomic idempotency via a `processed_events` table (dedup consumed events in the
  same transaction as the state change).
- The Per-service Definition of Done inherited from Phase 0 (zod config,
  `/healthz`+`/readyz`, graceful shutdown, broker retry/backoff, multi-stage
  Dockerfile + prod compose profile, CI).

**Out (deferred — YAGNI):**
- `StockLow` event — no consumer until Notification (Phase 5).
- `GET /reservations` inspection endpoint.
- `shop_id` / multi-shop and multi-location modelling.
- `OrderConfirmed` handling — Inventory takes no action on confirm (see the pool
  model below); the umbrella lists only `OrderPlaced` + `OrderCancelled` as consumed.

## Drive surface & standalone demo

`Order` (the real `OrderPlaced` producer) does not exist until Phase 2, so Phase 1
is driven two ways:

- **HTTP admin** — `POST /inventory/stock { productId, quantity, location? }`
  (add/seed stock; upsert — legacy `addStockToInventory` port) and
  `GET /inventory/:productId` (available level + active-reservation count). Plus the
  inherited `/healthz` and `/readyz`. Zod validation at the edge; `traceMiddleware`
  in front.
- **Kafka consumer** — subscribes to `order.events`, handles `OrderPlaced` and
  `OrderCancelled`.

**Demo:** `curl` to seed stock → a test (or CLI) publishes a hand-crafted
`OrderPlaced` to `order.events` → observe `InventoryReserved` on `inventory.events`
and the decremented `available` in the DB.

## Data model (Postgres `inventory` database)

The `inventory` database already exists — created by the Phase 0 infra init script
(`infra/postgres/init/01-databases.sql`). One Prisma schema for this service;
migrations via `prisma migrate dev` only (never hand-edited).

- **`inventories(product_id PK, available int CHECK (available >= 0), location text, updated_at timestamptz)`**
  — a **single sellable pool**. This mirrors the legacy `invent_stock`: reserve
  decrements `available`, release increments it. No `shop_id`, no product foreign
  key — Inventory trusts the incoming `productId`; product validity is Catalog's
  concern (DB-per-service rule; this intentionally drops legacy's cross-service
  `findProductById` check). Because the pool is already the *sellable* count, a
  confirmed order needs no Inventory action — the stock was deducted at reserve
  time — which is why `OrderConfirmed` is not consumed.
- **`reservations(id PK, order_id text, product_id text, quantity int, status text, expires_at timestamptz, created_at timestamptz, released_at timestamptz null)`**
  — `status ∈ {ACTIVE, RELEASED}`. One row per (order, product) line. Tracks each
  hold so it can be released on cancel or expiry.
- **`outbox(...)`** — same shape as the `hello` service's outbox (id, aggregate_type,
  aggregate_id, type, version, trace_id, producer, payload jsonb, occurred_at, sent_at).
- **`processed_events(event_id PK, consumer text, processed_at timestamptz)`** —
  atomic idempotency ledger for consumed Kafka events.

## Reserve flow — consume `OrderPlaced` (multi-item, all-or-nothing)

```
items sorted by product_id
acquireLock(product) for each product, in sorted order   // deadlock-free; distributed-lock lesson
try:
  BEGIN
    INSERT processed_events(event_id, consumer='inventory') ON CONFLICT DO NOTHING
      -- 0 rows affected => this event was already handled => COMMIT and ack (exactly-once)
    SAVEPOINT s
    ok = true
    for item in items:
      UPDATE inventories SET available = available - item.quantity, updated_at = now()
        WHERE product_id = item.productId AND available >= item.quantity
      if rowcount == 0: ok = false; break        -- shortfall on this line
    if ok:
      INSERT reservations(order_id, product_id, quantity, status='ACTIVE',
                          expires_at = now() + RESERVATION_TTL) for each item
      INSERT outbox <- InventoryReserved { orderId, items }
    else:
      ROLLBACK TO SAVEPOINT s                     -- undo partial decrements, keep processed_events
      INSERT outbox <- InventoryReservationFailed { orderId, reason: 'INSUFFICIENT_STOCK' }
  COMMIT
finally:
  releaseLock(product) for each
```

- The **conditional `UPDATE` is the correctness guarantee** — Postgres row locking
  makes each decrement atomic, so the reservation is race-safe even without the
  Redis lock. The Redis per-product lock is kept to **exercise and teach the
  distributed-lock pattern**; a code comment states SQL is the real guard.
- The **`SAVEPOINT`** lets a shortfall roll back the partial stock decrements while
  keeping the `processed_events` insert and emitting `InventoryReservationFailed` —
  consume + outcome + emit commit atomically in one transaction.
- **At-least-once safe:** a crash before `COMMIT` leaves no `processed_events` row
  and no stock change, so a redelivery simply retries. A crash after `COMMIT` is
  deduped by the `processed_events` unique key.

## Release flow — consume `OrderCancelled`, and the expiry sweeper

Both paths share one release primitive, per ACTIVE reservation of the order (cancel)
or per expired ACTIVE reservation (sweeper):

```
BEGIN
  (cancel path only) INSERT processed_events(event_id, consumer='inventory') ON CONFLICT DO NOTHING
                       -- 0 rows => already handled => COMMIT and ack
  for each ACTIVE reservation r in scope:
    UPDATE inventories SET available = available + r.quantity, updated_at = now()
      WHERE product_id = r.product_id
    UPDATE reservations SET status='RELEASED', released_at=now() WHERE id = r.id
  INSERT outbox <- InventoryReleased { orderId, items }
COMMIT
```

- **`OrderCancelled`** is deduped via `processed_events`, same as reserve.
- **Expiry sweeper** runs on an interval (`SWEEP_INTERVAL_MS`), selecting
  `status='ACTIVE' AND expires_at < now()`, releasing each and emitting
  `InventoryReleased`. In Phase 1 — with no Order to confirm a reservation — this is
  the mechanism by which a stranded hold frees up. The sweeper is idempotent: a
  reservation already flipped to `RELEASED` is not selected again.

## Contracts (`packages/contracts`)

Events are added to the single-source-of-truth contracts package; producers and
consumers import them so they cannot drift.

- **`events/order.ts`** (owned long-term by Order; defined here because Inventory
  needs them now — Phase 2 Order imports the same definitions):
  - `ORDER_PLACED = "order.placed"`, `OrderPlacedPayload { orderId: string; items: { productId: string; quantity: number }[] }` (each `quantity` positive int; `items` non-empty).
  - `ORDER_CANCELLED = "order.cancelled"`, `OrderCancelledPayload { orderId: string }`.
- **`events/inventory.ts`** (owned by Inventory):
  - `INVENTORY_RESERVED = "inventory.reserved"`, `InventoryReservedPayload { orderId: string; items: { productId: string; quantity: number }[] }`.
  - `INVENTORY_RESERVATION_FAILED = "inventory.reservation_failed"`, `InventoryReservationFailedPayload { orderId: string; reason: string }`.
  - `INVENTORY_RELEASED = "inventory.released"`, `InventoryReleasedPayload { orderId: string; items: { productId: string; quantity: number }[] }`.

**Topics:** each producer publishes to `<aggregateType>.events`. Inventory consumes
`order.events` (aggregateType `order`) and emits to `inventory.events` (aggregateType
`inventory`). The outbox relay's `topicFor(aggregateType)` maps `inventory` →
`inventory.events`.

## Configuration & inherited Definition of Done

Fail-fast zod config (via `@ecom/shared`): `DATABASE_URL`, `KAFKA_BROKERS`,
`REDIS_URL`, `RESERVATION_TTL_MS`, `SWEEP_INTERVAL_MS`, `PORT`, `LOG_LEVEL`.

Every production primitive is inherited from Phase 0 `shared`, not re-invented:
- `/healthz` (liveness) and `/readyz` (readiness — probes Postgres, Kafka, Redis).
- Graceful shutdown, in order: stop the Kafka consumer → stop the outbox relay →
  stop the sweeper → drain the HTTP server → close DB/Redis.
- Broker connect retry/backoff and Kafka consumer error boundary (DLQ-parking) from
  `shared`.
- Multi-stage Dockerfile + a `prod` compose profile entry, mirroring `services/hello`.
- CI already builds/lints/typechecks/tests the whole workspace — no workflow change.

## Testing (TDD)

- **Unit** — reserve logic against a fake port: all-or-nothing across items,
  shortfall on any line → `InventoryReservationFailed` with no stock change, and a
  duplicate `eventId` skips re-processing.
- **Integration** (compose stack — real Postgres + Kafka + Redis): reserve happy
  path, insufficient stock → Failed, `OrderCancelled` → release restores `available`,
  sweeper releases an expired reservation, duplicate `OrderPlaced` reserves once.
- **Slice e2e** — publish an `OrderPlaced` to `order.events`, assert
  `InventoryReserved` arrives on `inventory.events` and `available` is decremented.

## Definition of Done

- HTTP admin (`POST /inventory/stock`, `GET /inventory/:productId`) + `order.events`
  consumer live; reservations correct under concurrency.
- `InventoryReserved` / `InventoryReservationFailed` / `InventoryReleased` emitted via
  the outbox to `inventory.events`.
- Expiry sweeper releases stranded reservations.
- Idempotent consumers (`processed_events`); all-or-nothing multi-item reserve.
- Inherited DoD satisfied (config, health, shutdown, broker resilience, Dockerfile, CI).
- Unit + integration + slice-e2e tests green.

## Open questions

None outstanding — the three design forks (drive surface, concurrency control,
Phase-1 scope) were resolved during brainstorming on 2026-07-21.
