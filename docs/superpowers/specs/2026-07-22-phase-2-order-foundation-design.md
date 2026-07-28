# Phase 2a · Order (foundation) — Design (child spec)

> Child spec of the umbrella [`2026-07-18-microservices-streaming-rebuild-design.md`](./2026-07-18-microservices-streaming-rebuild-design.md).
> Phase 0 (platform) and Phase 1 (Inventory) are complete. This spec designs the **write-side foundation** of the Order service — everything up to and including emitting `OrderPlaced`.

## Purpose

Stand up the **Order** service far enough to open the checkout saga: a cart, a
local catalog price projection, and a `placeOrder` that writes an order plus an
`OrderPlaced` event to its outbox in one Postgres transaction. This is the base
common to every saga variant, so it is deliberately built **before** deciding how
far to carry the saga (the reserve-leg / full-state-machine / payment-stub fork).

Order's real saga partners — **Payment** and **Catalog** — do not exist yet.
Following the Phase-1 precedent, the foundation is still an independently runnable,
demoable slice: HTTP seeds the cart and prices, `POST /orders` emits a real
`OrderPlaced`, and the **live Inventory service reserves against it** end-to-end.
No throwaway stubs.

## Scope

**In:**
- Service scaffold — `@ecom/order` package mirroring `services/inventory`.
- Postgres `order` database (pre-created by Phase-0 `infra/postgres/init/01-databases.sql`), one Prisma schema, migrations via CLI only.
- **Cart** HTTP surface — add/increment, set quantity (0 removes), remove, get. One cart per user.
- **catalog_read_model** — an HTTP admin seed surface (`POST /admin/catalog`) standing in for Catalog until it exists.
- **Checkout / `placeOrder`** — price the cart from the LOCAL read model; in one transaction create the order (`PENDING`) + order items (price snapshot), clear the cart, and enqueue `OrderPlaced` to the outbox.
- Transactional outbox → `order.events`, drained by the shared relay.
- `GET /orders/:id` read (status + items).
- Per-service Definition of Done inherited from Phase 0 (zod config, `/healthz`+`/readyz`, graceful shutdown, broker retry/backoff, multi-stage Dockerfile + prod compose profile, CI).

**Out (deferred — YAGNI):**
- **Consuming saga-result events** (`InventoryReserved` / `InventoryReservationFailed`, payment events) and the state **transitions** they drive. The next slice — where the reserve-leg / full-state-machine / payment-stub decision is made.
- `ChargePayment` (RabbitMQ command), payment-result handling, `OrderConfirmed`, the `CONFIRMED` path.
- **`ProcessedEvent` idempotency ledger** — only a Kafka consumer needs it; the foundation has no consumer. Added with the consumer slice.
- **Live catalog projection** (`PriceChanged` / `ProductCreated` consumer) and the `contracts/events/catalog.ts` schema — added when Catalog exists. The foundation feeds the read model by HTTP admin only.
- **SSE** `GET /orders/:id/stream` — a forward dependency on the Gateway (umbrella §Sync read surface).
- Discounts (fold into Catalog), multi-shop, shipping.
- Real auth — `x-user-id` header is a temporary stand-in (see Known Limitations).

## Drive surface & standalone demo

- **Cart** — `POST /cart/items { productId, quantity }` (add/increment),
  `PATCH /cart/items/:productId { quantity }` (set; `0` removes),
  `DELETE /cart/items/:productId`, `GET /cart`. User identified by the
  `x-user-id` request header. Zod validation at the edge; `traceMiddleware` in front.
- **Catalog admin** — `POST /admin/catalog { productId, name, price }` (upsert into
  `catalog_read_model`; `price` in integer minor units).
- **Checkout** — `POST /orders` (place the current user's cart) and
  `GET /orders/:id`. Plus inherited `/healthz` and `/readyz`.

**Demo:** `curl` to seed a price → add the product to the cart → `POST /orders` →
observe the order row at `PENDING` with a snapshotted total, and `OrderPlaced` on
`order.events`. With the Phase-1 Inventory service running, that same event drives
a real reservation (visible via Inventory's `GET /inventory/:productId`). Order
does not yet react to the reservation result — that is the next slice.

## Data model (Postgres `order` database)

The `order` database already exists (Phase-0 init script; note it is quoted there —
`CREATE DATABASE "order"` — because `order` is a SQL reserved word; the
connection-string reference is unaffected and no service code emits raw SQL naming
it). One Prisma schema; migrations via `prisma migrate dev` only. Convention follows
`services/inventory`: **PascalCase models, camelCase fields, no `@map`**; prices and
totals are **integer minor units** (never floats).

- **`model Cart { userId String @id; items CartItem[]; createdAt DateTime @default(now()); updatedAt DateTime @updatedAt }`**
  — one active cart per user, keyed by the `x-user-id` value.
- **`model CartItem { id String @id @default(uuid()); userId String; productId String; quantity Int; cart Cart @relation(fields:[userId], references:[userId], onDelete: Cascade) }`**
  with `@@unique([userId, productId])` — one line per (user, product); add-to-cart increments.
- **`model Order { id String @id @default(uuid()); userId String; status String @default("PENDING"); totalPrice Int; items OrderItem[]; createdAt DateTime @default(now()); updatedAt DateTime @updatedAt }`**
  with `@@index([userId])`. `status` is a string enum; see the status model below.
- **`model OrderItem { id String @id @default(uuid()); orderId String; productId String; quantity Int; unitPrice Int; order Order @relation(fields:[orderId], references:[id], onDelete: Cascade) }`**
  with `@@index([orderId])` — `unitPrice` is the price **snapshot** at placement, so a later `PriceChanged` never rewrites history.
- **`model CatalogReadModel { productId String @id; name String; price Int; updatedAt DateTime @updatedAt }`**
  — the local price projection. Fed by HTTP admin in the foundation; by a Catalog
  `PriceChanged` consumer later. Order **never** reads Catalog's database (DB-per-service).
- **`model Outbox {...}`** — the exact shape from `services/inventory` / `services/hello`
  (`id, aggregateType, aggregateId, type, version, traceId, producer, payload, occurredAt, sentAt`, `@@index([sentAt])`).

## Order status model

Target lifecycle for the whole saga: `PENDING → AWAITING_PAYMENT → CONFIRMED`, with
`CANCELLED` as the compensation terminal. **This slice implements only `PENDING`** —
it is the sole reachable state, since every transition trigger (reservation result,
payment result) is out of scope. No transition function is written yet; `placeOrder`
sets `PENDING` directly. The transition table + `canTransition`/`transition` logic
land in the slice that first drives a transition, tested against the events that
cause them — not pre-built here (YAGNI).

## Checkout flow — `placeOrder` (priced from the local read model)

`placeOrder` is a **pure domain core** over a port (mirrors `inventory/reserve.ts`);
the HTTP handler runs it inside one `prisma.$transaction`. Cart mutations and the
catalog upsert are direct Prisma in the app layer (mirrors `inventory` stock upsert —
trivial CRUD needs no pure core).

```
placeOrder(tx, { userId, items }):
  if items is empty:                      return "EMPTY"          -- no writes
  priced = []
  for line in items:
    price = tx.priceOf(line.productId)     -- from catalog_read_model
    if price is null or price <= 0:        return "UNPRICED"      -- no writes; cart NOT cleared
    priced.push({ ...line, unitPrice: price })
  total = sum(line.quantity * line.unitPrice)
  orderId = tx.createOrder({ userId, status: "PENDING", items: priced, totalPrice: total })
  tx.clearCart(userId)
  tx.enqueue(ORDER_PLACED, orderId, { orderId, items: items.map(pick productId+quantity) })
  return "PLACED"
```

- **All-or-nothing pricing:** any unpriced/zero-price line aborts **before** any write
  (`UNPRICED`), so the order is never partially priced and the cart is left intact.
- **`OrderPlaced` payload** is exactly the existing contract `{ orderId, items:[{ productId, quantity }] }`
  — no price leaks onto the wire; the snapshot lives only in Order's `OrderItem`.
- **One transaction:** order + items + cart-clear + outbox row commit atomically, so
  the dual-write problem (DB vs Kafka) is handled by the outbox exactly as in Inventory.
- **Business failures are HTTP 4xx, never thrown to a DLQ** — there is no consumer to
  dead-letter to; `EMPTY` → 400, `UNPRICED` → 422.

## Contracts (`packages/contracts`)

**No contract change.** `OrderPlaced` / `ORDER_PLACED` already exist in
`events/order.ts` (defined during Phase 1, owned long-term by Order) and fit as-is.
`OrderConfirmed`, the payment command/events, and `events/catalog.ts` are introduced
by the slices that first produce or consume them.

**Topics:** the relay maps `order → order.events` via `topicFor(aggregateType)`.
Order is the producer on `order.events`; Inventory (Phase 1) is already its consumer.

## Configuration & inherited Definition of Done

Fail-fast zod config (via `@ecom/shared`): `DATABASE_URL`, `KAFKA_BROKERS`, `PORT`,
`LOG_LEVEL`. **No `REDIS_URL`** — the foundation has no locks and no consumer to
dedup (idempotency via Redis/`ProcessedEvent` arrives with the consumer slice).

Every production primitive is inherited from Phase-0 `shared`, not re-invented:
- **`db.ts`** loads this service's `.env` then constructs `PrismaClient` imported from
  **`./generated/prisma`** (custom per-service output, gitignored via `**/generated/`) —
  the same pattern as `services/inventory/src/db.ts`, **not** `@prisma/client`.
- **`main.ts`** wires the producer + relay + app (no consumer/sweeper this slice):
  `createKafka("order") → createProducer → producer.connect()`, then
  `startOutboxRelay(outboxPort, producer, (t) => \`${t}.events\`, { intervalMs: 500 })`,
  then `app.listen`. Graceful shutdown via `gracefulShutdown([...])` (reverse teardown):
  server drained first, then relay stopped, producer disconnected, `prisma.$disconnect()` last.
- **`/healthz`** (liveness) and **`/readyz`** (readiness — probes Postgres via `createHealthRouter({ db })`).
- Broker connect retry/backoff from `shared`.
- Plain express handlers + zod `safeParse` at the edge (there is no `shared` `BaseController`; mirror Inventory).
- Multi-stage Dockerfile + an `order` entry under the `app` compose profile in `docker-compose.example.yml`, mirroring `services/inventory`.
- CI already builds/lints/typechecks/tests the whole workspace — no workflow change.

## Known limitations (intentional, this slice)

1. **Stranded reservations.** Inventory reserves on `OrderPlaced` with a
   `RESERVATION_TTL_MS` (default 15 min) hold, but Order has **no confirm path** yet,
   so every reservation is auto-released by Inventory's sweeper after the TTL while the
   order stays `PENDING` forever. This is the sibling's forward note
   (`2026-07-21-phase-1-inventory-design.md:185-188`) coming due; the confirm path
   lands with the saga-result slice. The demo completes in seconds, well under the TTL.
2. **No `POST /orders` idempotency.** A double-submit creates two orders and two
   `OrderPlaced` events. Acceptable for a client-driven HTTP call (not at-least-once
   Kafka delivery); an idempotency key is a candidate for the Gateway edge later.
3. **Manual price seeding.** `catalog_read_model` is fed only by `POST /admin/catalog`
   until Catalog's `PriceChanged` projection exists.
4. **`x-user-id` header auth.** A temporary stand-in until Gateway/Identity provide
   JWT-over-httpOnly-cookie auth; the header is trusted as-is in the foundation.
5. **Order is deaf to results.** It emits `OrderPlaced` but does not yet consume
   `InventoryReserved/Failed` — the next slice.

## Testing (TDD)

- **Unit** — `placeOrder` core against a fake port: empty cart → `EMPTY` (no writes);
  an unpriced/zero-price line → `UNPRICED` (no writes, cart intact); happy path →
  `PLACED` with correct `totalPrice`, snapshotted `unitPrice`s, an `OrderPlaced`
  payload of `{ orderId, items }`, and the cart cleared.
- **Integration** (compose stack — real Postgres + Kafka): cart add/increment/set(0=remove)/delete/get;
  `POST /admin/catalog` upsert; `POST /orders` writes `Order=PENDING` + `OrderItem`s
  (price snapshot) + clears the cart + one `OrderPlaced` outbox row, all in one tx;
  `UNPRICED` → 422 with no order/outbox/cart-clear; `GET /orders/:id` (200 + 404); `GET /readyz` 200.
- **Slice e2e** — seed catalog + cart via HTTP, `POST /orders`, assert an `OrderPlaced`
  envelope arrives on `order.events` (real Kafka) with matching `items`.

## Definition of Done

- Cart CRUD, `POST /admin/catalog`, `POST /orders`, `GET /orders/:id` live.
- `placeOrder` writes `PENDING` + items (price snapshot) + cart-clear + `OrderPlaced`
  outbox row atomically; the relay publishes it to `order.events`.
- `EMPTY`/`UNPRICED` are HTTP 4xx business outcomes, never thrown.
- Inherited DoD satisfied (zod config, health, graceful shutdown, Dockerfile + `app`
  compose profile, CI green).
- Unit + integration + slice-e2e tests green.

## Open questions

None blocking. Resolved in brainstorming/review on 2026-07-22: foundation is scoped as
the write-side base (the reserve-leg / full-state-machine / payment-stub fork is the
**next** slice); the state machine is trimmed to `PENDING`; `ProcessedEvent` and the
catalog projection are deferred to the slices that need them; `x-user-id` is the
accepted temporary auth stand-in.
