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
migrations via `prisma migrate dev` only (never hand-edited). Models follow the
convention established by `services/hello`: **PascalCase Prisma models, camelCase
fields, no `@map`** (the umbrella prose uses snake_case logical names — the Prisma
model is the implementation shape).

- **`model Inventory { productId String @id; available Int; location String; updatedAt DateTime }`**
  — a **single sellable pool** (`available >= 0`, DB check constraint). Mirrors the
  legacy `invent_stock`: reserve decrements `available`, release increments it. No
  `shopId`, no product foreign key — Inventory trusts the incoming `productId`;
  product validity is Catalog's concern (DB-per-service rule; this intentionally
  drops legacy's cross-service `findProductById` check). Because the pool is already
  the *sellable* count, a confirmed order needs no Inventory action — the stock was
  deducted at reserve time — which is why `OrderConfirmed` is not consumed.
- **`model Reservation { id String @id @default(uuid()); orderId String; productId String; quantity Int; status String; expiresAt DateTime; createdAt DateTime @default(now()); releasedAt DateTime? }`**
  — `status ∈ {ACTIVE, RELEASED}`. One row per (order, product) line. Add a
  **partial unique index** `@@unique([orderId, productId])` scoped to
  `status='ACTIVE'` (via a raw partial index in the migration) so a double-reserve
  is impossible at the DB level even outside the `ProcessedEvent` dedup.
- **`model Outbox {...}`** — the exact shape from `services/hello/prisma/schema.prisma`
  (`id, aggregateType, aggregateId, type, version, traceId, producer, payload,
  occurredAt, sentAt`, `@@index([sentAt])`).
- **`model ProcessedEvent { eventId String @id; type String; processedAt DateTime @default(now()) }`**
  — **reuses the sibling `hello` model verbatim** (`services/hello/prisma/schema.prisma:31`)
  as the atomic idempotency ledger. No `consumer` column — Inventory is a single
  service with one consumer group; `type` carries the event type, matching hello.

## Reserve flow — consume `OrderPlaced` (multi-item, all-or-nothing)

```
items sorted by productId
acquireLock(product) for each product, in sorted order   // deadlock-free; distributed-lock lesson
try:
  BEGIN
    INSERT ProcessedEvent(eventId, type='order.placed') ON CONFLICT DO NOTHING
      -- 0 rows affected => this event was already handled => COMMIT and ack (exactly-once)
    SAVEPOINT s
    ok = true
    for item in items:
      UPDATE Inventory SET available = available - item.quantity, updatedAt = now()
        WHERE productId = item.productId AND available >= item.quantity
      if rowcount == 0: ok = false; break        -- shortfall on this line
    if ok:
      INSERT Reservation(orderId, productId, quantity, status='ACTIVE',
                         expiresAt = now() + RESERVATION_TTL) for each item
      INSERT Outbox <- InventoryReserved { orderId, items }
    else:
      ROLLBACK TO SAVEPOINT s                     -- undo partial decrements, keep ProcessedEvent
      INSERT Outbox <- InventoryReservationFailed { orderId, reason: 'INSUFFICIENT_STOCK' }
  COMMIT
finally:
  releaseLock(product) for each
```

- **Insufficient stock is a business outcome, never a thrown error.** The shared
  Kafka consumer parks any thrown handler error to `<topic>.dlq` and commits
  (`packages/shared/src/kafka.ts`), so a shortfall must be emitted as
  `InventoryReservationFailed` and the handler must return normally — throwing would
  dead-letter a perfectly valid `OrderPlaced` to `order.events.dlq` and silently
  break the saga's failure branch. Only *unexpected* errors (DB down, lock backend
  unreachable) propagate to the DLQ.
- The **conditional `UPDATE` is the correctness guarantee** — Postgres row locking
  makes each decrement atomic, so the reservation is race-safe even without the
  Redis lock. The Redis per-product lock is kept to **exercise and teach the
  distributed-lock pattern**; a code comment states SQL is the real guard.
- The **`SAVEPOINT`** lets a shortfall roll back the partial stock decrements while
  keeping the `ProcessedEvent` insert and emitting `InventoryReservationFailed` —
  consume + outcome + emit commit atomically in one transaction.
- **At-least-once safe:** a crash before `COMMIT` leaves no `ProcessedEvent` row and
  no stock change, so a redelivery simply retries. A crash after `COMMIT` is deduped
  by the `ProcessedEvent` primary key.

## Release flow — consume `OrderCancelled`, and the expiry sweeper

Both paths share one release primitive, per ACTIVE reservation of the order (cancel)
or per expired ACTIVE reservation (sweeper):

```
BEGIN
  (cancel path only) INSERT ProcessedEvent(eventId, type='order.cancelled') ON CONFLICT DO NOTHING
                       -- 0 rows => already handled => COMMIT and ack
  active = ACTIVE reservations in scope (this order, or expired for the sweeper)
  if active is empty: COMMIT and return   -- no-op: nothing held; do NOT emit InventoryReleased
  for each reservation r in active:
    UPDATE Inventory SET available = available + r.quantity, updatedAt = now()
      WHERE productId = r.productId
    UPDATE Reservation SET status='RELEASED', releasedAt=now() WHERE id = r.id
  INSERT Outbox <- InventoryReleased { orderId, items }   -- only when something was actually released
COMMIT
```

- **Empty-release guard:** when no ACTIVE reservations remain (e.g. the sweeper
  already released the order before `OrderCancelled` arrived), the path commits and
  returns without emitting a spurious empty `InventoryReleased`.
- **`OrderCancelled`** is deduped via `ProcessedEvent`, same as reserve.
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

> **Forward note:** once Order (Phase 2) drives the real saga, `RESERVATION_TTL_MS`
> must exceed the maximum saga duration (reserve → charge → confirm), or the sweeper
> will release legitimate in-flight orders before they confirm. Phase 1 has no
> confirm path, so this only bites in Phase 2 — flagged here so it isn't forgotten.

The outbox relay maps only `inventory → inventory.events` (`topicFor(aggregateType)`);
Inventory is the sole producer on that topic.

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

None blocking — the three design forks (drive surface, concurrency control, Phase-1
scope) were resolved during brainstorming on 2026-07-21. Decisions locked in review:
the **single sellable pool** model (no separate `reserved` column) is intentional and
final; **`ProcessedEvent` retention/pruning** is deferred (matches `hello`, which has
none) — revisit before Phase 7 if the ledger grows unbounded.
