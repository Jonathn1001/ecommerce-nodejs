# Microservices + Data-Streaming Rebuild — Design

- **Date:** 2026-07-18
- **Status:** Approved (umbrella spec)
- **Author:** elgnas (with Claude Code)
- **Repo:** `ecommerce-nodejs`

## Purpose

Turn the existing Express + Mongoose **monolith** into a **learning platform for
system design, microservices, and data streaming**. The current app claims an
event-driven, microservice-ready architecture in its README, but in reality:

- It is a single-process monolith on MongoDB.
- **Redis** is the only real broker use — a distributed lock in checkout.
- **Kafka** and **RabbitMQ** exist *only* as isolated demo scripts under
  `src/tests/` and are not wired into the app.
- **Payment** is a stub: `placeOrder` accepts `user_payment = {}`, stores it on
  the order, and never charges anything.

The goal is not to ship a production store. It is to **learn the patterns by
building them on a real domain**, with each technology assigned a distinct role
so the "when to use which" lesson is explicit.

## Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Target shape | **True microservices split now** (not event-driven monolith, not sandbox) |
| 2 | Granularity | **6 services + gateway** (Identity, Catalog, Order, Inventory, Payment, Notification) |
| 3 | Data ownership | **Database-per-service**, no cross-service DB reads |
| 4 | Database | **PostgreSQL** (migrated off MongoDB) |
| 5 | Stack | **TypeScript + Express + Prisma** per service; shared `contracts` package |
| 6 | Broker roles | **Kafka** = event backbone · **RabbitMQ** = commands/tasks + DLQ · **Redis** = cache + lock + idempotency |
| 7 | Sync calls | REST only at the **gateway edge**; services stay decoupled via events |
| 8 | Repo layout | **Monorepo**; old monolith kept as `legacy/` read-only reference |
| 9 | Infra in git | Commit `docker-compose.example.yml` + `docs/infra.md`; real `docker-compose.yml` and `.env` **gitignored** |
| 10 | Payment | **Own service** with a **simulated gateway** (deterministic success/fail/timeout); real Stripe test-mode is an optional later swap |

## System topology

```
                          +-------------+
        client --HTTPS-->  |   Gateway   |  JWT verify - routing - rate-limit - trace-id
                          +------+------+   (no DB, no business logic)
        +-----------+---------+---+-------+-----------+-------------+
        v           v         v           v           v             v
   +---------+ +---------+ +---------+ +----------+ +---------+ +--------------+
   |Identity | | Catalog | |  Order  | |Inventory | | Payment | | Notification |
   +----+----+ +----+----+ +----+----+ +----+-----+ +----+----+ +------+-------+
     own PG      own PG      own PG      own PG       own PG        own PG
        |           |           |           |            |             |
        +--------- KAFKA (domain event log) -+------------+-----+-------+
                                                                |
                        RabbitMQ (commands/tasks + DLQ) --------+
                        Redis (lock - cache - idempotency)
```

## Service responsibilities (ported from `legacy/`)

| Service | Owns (Postgres) | Legacy sources | Emits (Kafka) | Consumes |
|---|---|---|---|---|
| **Gateway** | — | `app.js`, `auth/checkAuth`, `auth/authUtils` | — | — |
| **Identity** | users, api_keys, key_tokens, roles, resources, grants | `access/apiKey/keyToken/rbac` services | `UserRegistered` | — |
| **Catalog** | products (+type attrs), comments, discounts | `product/comment/discount` services, product factory config | `ProductCreated/Updated`, `PriceChanged` | — |
| **Order** | carts, orders, **catalog_read_model** (projection) | `cart/checkout` services, order repo | `OrderPlaced/Confirmed/Cancelled` | `InventoryReserved/Failed`, `PaymentSucceeded/Failed`, `PriceChanged` |
| **Inventory** | inventories, reservations | `inventory` service, `redis.service` lock | `InventoryReserved/Failed/Released`, `StockLow` | `OrderPlaced`, `OrderCancelled` |
| **Payment** | payments, payment_attempts | (new — payment was a stub) | `PaymentSucceeded/Failed/Refunded` | `ChargePayment` (RabbitMQ cmd) |
| **Notification** | notifications | `notification/email/otp` services | — | order + catalog events (Kafka) → RabbitMQ dispatch |

Notes:
- **Discount** folds into Catalog; **Cart** folds into Order — to hit the
  6-service target.
- The Redis distributed lock (today in checkout) **moves into Inventory**, where
  reservation concurrency belongs.

## The checkout saga (choreographed)

Event-driven choreography — each service reacts to events; no central
orchestrator. **Reserve first** (cheap, reversible), **charge second**
(expensive, external).

```
1. Order.placeOrder -> price the cart from Order's LOCAL catalog_read_model
                       (no sync call to Catalog -> decoupled)
2. Order writes order=PENDING + OrderPlaced to its OUTBOX (one TX)
                    --> KAFKA order.events
3. Inventory consumes OrderPlaced
      -> Redis lock per product -> reserve in own DB (expires_at set)
      ok   --> KAFKA InventoryReserved
      fail --> KAFKA InventoryReservationFailed
4. Order consumes the result
      Reserved -> emit ChargePayment  (RABBITMQ command, retry + DLQ)
      Failed   -> order=CANCELLED, emit OrderCancelled
5. Payment consumes ChargePayment
      -> simulated gateway (deterministic success/fail/timeout)
      -> provider webhook may confirm asynchronously
      ok   --> KAFKA PaymentSucceeded
      fail --> KAFKA PaymentFailed
6. Order consumes the payment result
      Succeeded -> order=CONFIRMED, emit OrderConfirmed
      Failed    -> order=CANCELLED, emit OrderCancelled  (compensation)
7. Inventory consumes OrderCancelled -> release stock  (compensation)
8. Notification consumes OrderPlaced/Confirmed/Cancelled (KAFKA)
      -> enqueue SendEmail as a RABBITMQ command (retry + dead-letter queue)
      -> worker sends; poison messages land in notifications.dlx
```

**Correctness properties**
- Every Kafka consumer is **at-least-once** → each **dedupes on `eventId`** via
  Redis (`SET NX` + TTL) or a `processed_events` table.
- Reservations carry `expires_at`; an order that never confirms is auto-released
  (compensating action). Legacy already has `releaseInventory` + rollback logic
  to port.
- Payment uses **provider idempotency keys** so a retried `ChargePayment` charges
  exactly once.

**Later comparison lesson:** rebuild the same saga as an **orchestrated** state
machine inside Order and compare tracing + failure handling. Building both is
itself curriculum.

## Data ownership rules

- Each service owns exactly one Postgres database. A service **never** reads
  another service's database.
- Cross-service data need is met by **consuming events** (preferred — e.g.
  Order's `catalog_read_model` projection) or, at the gateway edge, a **sync REST
  call**.
- Schema per service is managed by **Prisma migrations** (`prisma migrate dev`),
  one Prisma schema per service. Migration files are never hand-edited.

Representative tables:
- **Identity:** `users`, `api_keys`, `key_tokens`, `roles`, `resources`, `role_grants`
- **Catalog:** `products` (+ type attributes, e.g. jsonb or per-type tables),
  `comments`, `discounts`, `discount_usages`
- **Order:** `carts`, `cart_items`, `orders`, `order_items`, `catalog_read_model`, `outbox`
- **Inventory:** `inventories`, `reservations`, `outbox`
- **Payment:** `payments`, `payment_attempts`, `outbox`
- **Notification:** `notifications`

## Platform building blocks (`packages/`)

- **`contracts`** — single source of truth for every event and DTO. TypeScript
  types + **zod** runtime validation. Versioned envelope:
  `{ eventId, type, version, occurredAt, traceId, producer, payload }`.
  Producers and consumers import from here so they cannot drift. Contract-tested.
  Schema evolution (`v1 -> v2`) is a later lesson.
- **`shared`** — structured logger (winston, **no PII** — log ids/codes, never
  `password`/token/email+name pairs), `AppError` family (ported from
  `legacy/utils`), `BaseController`, **Kafka/RabbitMQ/Redis client wrappers**,
  **outbox relay**, **idempotency helper**, **trace-id middleware** (ported from
  `trace-log.middleware`).

## Three system-design patterns baked in

1. **Transactional outbox** — fixes the dual-write problem (a DB write and a
   Kafka publish cannot be atomic). Each service writes events to an `outbox`
   table *in the same Postgres transaction* as the state change; a relay
   publishes to Kafka and marks rows sent.
2. **Idempotency** — Kafka is at-least-once, so every consumer dedupes on
   `eventId` (Redis `SET NX` + TTL, or a `processed_events` table). Payment also
   uses provider idempotency keys.
3. **Distributed tracing** — the Gateway mints a `traceId`, propagated through
   both sync headers and event envelopes, so one checkout can be followed across
   all six services. `trace-log.middleware` is the seed.

## Observability — three pillars (no overlap)

| Pillar | Tooling | Answers |
|---|---|---|
| **Logs** | winston structured JSON (Phase 0, `shared`) | what happened, per event |
| **Metrics** | **Prometheus** (scrapes each service `/metrics`, stores time-series, alerts) + **Grafana** (dashboards on top; stores nothing itself) | how much / how fast, over time |
| **Traces** | OpenTelemetry → **Jaeger** | one request's span timeline across services |

Prometheus and Grafana are **complementary, not duplicative**: Prometheus is the
time-series store + scraper, Grafana is the visualization layer that queries it.
Domain metrics to expose: Kafka **consumer lag**, RabbitMQ **queue + DLQ depth**,
**saga step latency**, reservation conflicts, HTTP p95 per service. Wired in
Phase 7.

## Broker role assignment

| Broker | Role | Patterns learned |
|---|---|---|
| **Kafka** | Durable domain-event backbone | topics, partitions (key by aggregate id), consumer groups, replay, at-least-once, schema evolution |
| **RabbitMQ** | Commands/tasks (`ChargePayment`, `SendEmail`) | exchanges, routing keys, retries, **dead-letter queue**, work distribution |
| **Redis** | Cache + distributed lock + idempotency | `SET NX` lock, TTL, response cache, dedup keys, optional Streams |

## Infrastructure (local)

- Committed: `docker-compose.example.yml` (no secrets, env-interpolated) and
  `docs/infra.md` runbook.
- Gitignored: `docker-compose.yml` (your local copy) and `.env`.
- Stack: one Postgres per service (or one Postgres server + one database per
  service for lighter local footprint — decided in Phase 0), Kafka + Zookeeper/
  KRaft, RabbitMQ (with management UI), Redis, Kafka-UI. **Phase 7 adds**
  Prometheus, Grafana, and Jaeger.

## Testing (TDD)

- Unit tests per service.
- Integration tests with **testcontainers** (real Postgres/Kafka/RabbitMQ/Redis
  spun up per test run).
- Contract tests on the `contracts` package.
- One **e2e saga test** driving the happy path plus an injected payment failure,
  asserting refund + inventory release.

## Build order

Each phase is an independently runnable, demoable slice, and gets its **own child
spec → plan → implementation cycle**. This document is the umbrella spec.

| Phase | Delivers | Rationale |
|---|---|---|
| **0 · Platform** | workspaces, TS, `contracts` + `shared` packages, `docker-compose.example` (Postgres, Kafka, RabbitMQ, Redis, Kafka-UI), broker wrappers, outbox relay, idempotency helper, trace middleware, structured logger. Proven by a **"hello event"**: producer → Kafka → consumer with dedup. No business logic. | Tracer bullet through the *infrastructure*; de-risks everything before domain work. |
| **1 · Inventory** | own DB, reserve/release, Redis lock, events | Leaf the saga depends on; ports `inventory` + `redis.service`. |
| **2 · Order** | cart + checkout + place order; choreographed saga vs Inventory; compensation; reservation expiry | The core loop with the fewest participants. |
| **3 · Payment** | simulated gateway, charge/refund, webhook | Completes the full saga with compensation. |
| **4 · Catalog** | products/comments/discounts + Order's `catalog_read_model` projection (consume `ProductCreated`/`PriceChanged`) | Decouples checkout from Catalog via events. |
| **5 · Notification** | consume order/catalog events (Kafka) → dispatch email/push via RabbitMQ + DLQ + retry | RabbitMQ showcase. |
| **6 · Identity + Gateway** | auth/rbac extracted; gateway verifies JWT and routes to all services | Front door built last, once services exist. |
| **7 · (optional) Hardening** | **Prometheus + Grafana** (metrics dashboards: consumer lag, DLQ depth, saga latency), OpenTelemetry + Jaeger tracing, orchestrated-saga variant (comparison), chaos test (kill a broker/service), schema-evolution `v2` event | Depth lessons once the spine is solid. |

## Out of scope (for now)

- Real payment provider / real money (simulated gateway only; Stripe test-mode is
  an optional later swap).
- Kubernetes / cloud deployment (local docker-compose only).
- Frontend.
- Polyglot persistence (all Postgres for this pass; per-workload DB choice is a
  possible future lesson).

## Open questions for Phase 0 planning

1. One Postgres container with a database per service, or one container per
   service? (footprint vs isolation realism)
2. Kafka in KRaft mode (no Zookeeper) vs Zookeeper-backed for the local stack.
3. npm workspaces vs pnpm workspaces for the monorepo (workspace elsewhere uses
   both; pick per this repo).
4. Outbox relay: simple polling loop first, or Debezium/logical decoding later.
