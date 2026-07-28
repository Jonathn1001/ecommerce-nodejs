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
| 11 | Quality bar | **Production-grade engineering, runs locally** — CI, per-service Dockerfiles, security hardening, resilience (retries/backoff/circuit breakers/timeouts), full observability, load + chaos tests, runbooks. No cloud/k8s deploy; payment stays simulated |

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
- **Load tests** (k6) against the checkout path and **chaos tests** (kill a broker
  / a service mid-saga) asserting the system recovers without lost or double
  effects.
- **Frontend e2e** (Playwright) on the storefront happy path — browse → cart →
  checkout → order confirmed (Phase 8).

## Production-readiness (non-functional requirements)

The quality bar is production-grade engineering that runs locally (decision #11).
Every requirement below is *local-first* — no cloud, no k8s, payment simulated —
but built to real-world standards.

**Security**
- Input validation with zod at every edge (HTTP body/params, event payloads).
- AuthN via JWT (Identity-issued), authZ via RBAC at the gateway and per service.
- Rate limiting + `helmet` security headers at the gateway.
- Secrets only via env / `.env` (gitignored); never committed, never logged.
- Dependency scanning in CI (`pnpm audit` + a scanner step).

**Resilience**
- Every outbound call (HTTP, broker, DB) has a **timeout**.
- **Retries with exponential backoff + jitter** on transient failures; bounded.
- **Circuit breaker** on sync service-to-service calls (gateway edge).
- Idempotent consumers (dedup on `eventId`); **DLQ + documented replay** for both
  Kafka (parking topic) and RabbitMQ (dead-letter queue).
- **Graceful shutdown**: stop intake, drain in-flight work, close broker/DB
  connections, then exit, on SIGTERM/SIGINT.

**Observability & SLOs**
- Three pillars (logs/metrics/traces) wired per service.
- Per-service **RED metrics** (Rate, Errors, Duration) + domain metrics
  (consumer lag, DLQ depth, saga latency).
- Target **SLOs**: checkout p95 < 500 ms (excluding simulated-gateway latency),
  saga completion p99 < 5 s, error rate < 1%. Alerting rules on SLO burn.

**Delivery & operability**
- **CI** on every push/PR: install → lint → typecheck → unit + integration tests
  (brokers/DB via services) → build → dependency scan.
- **Per-service multi-stage Dockerfile**; a `docker-compose` prod profile builds
  and runs the images (not just the infra).
- **Config validation at boot** (zod) — a service fails fast on missing/invalid env.
- **Health probes**: `/healthz` (liveness) + `/readyz` (readiness — checks DB/
  broker reachability).
- **Zero-downtime migrations**: expand/contract pattern (add nullable → backfill →
  switch → drop), never a destructive change in one deploy.
- **Runbook** per service (how to run, common failures, replay a DLQ, roll back).

## Per-service Definition of Done

A phase is not complete until its service meets ALL of:

- [ ] Own Postgres database + Prisma schema + migration (expand/contract-safe).
- [ ] zod-validated config at boot; fails fast on bad env.
- [ ] `/healthz` + `/readyz` endpoints; compose healthcheck wired to `/readyz`.
- [ ] Graceful shutdown draining in-flight work and closing connections.
- [ ] All outbound calls have timeouts; transient failures retried with backoff.
- [ ] Idempotent event consumers; DLQ path + replay documented.
- [ ] Transactional outbox for every emitted event.
- [ ] Structured logs (no PII), RED + domain metrics exposed, traces propagated.
- [ ] Unit + integration (testcontainers) + contract tests; green in CI.
- [ ] Multi-stage Dockerfile; image builds and runs in the prod compose profile.
- [ ] Runbook entry.

## Build order

Each phase is an independently runnable, demoable slice, and gets its **own child
spec → plan → implementation cycle**. This document is the umbrella spec. **Every
phase's service must satisfy the Per-service Definition of Done before it is
complete**; the production primitives (config validation, health probes, graceful
shutdown, broker resilience, Dockerfile, CI) are established in Phase 0 and
inherited by every later service.

| Phase | Delivers | Rationale |
|---|---|---|
| **0 · Platform** | workspaces, TS, `contracts` + `shared` packages, `docker-compose.example` (Postgres, Kafka, RabbitMQ, Redis, Kafka-UI), broker wrappers (with retry/backoff + consumer error boundary), outbox relay, idempotency helper, trace middleware, structured logger — **plus the production primitives every service inherits**: zod config validation, `/healthz`+`/readyz`, graceful shutdown, lint/format, a multi-stage Dockerfile template, and CI. Proven by a **"hello event"**: producer → Kafka → consumer with dedup. No business logic. | Tracer bullet through the *infrastructure*; de-risks everything and sets the production template before domain work. |
| **1 · Inventory** | own DB, reserve/release, Redis lock, events | Leaf the saga depends on; ports `inventory` + `redis.service`. |
| **2 · Order** | cart + checkout + place order; choreographed saga vs Inventory; compensation; reservation expiry; **sync read API (`GET /orders/:id`) + SSE order-status stream** off the state machine (the surface Phase 8 consumes) | The core loop with the fewest participants. |
| **3 · Payment** | simulated gateway, charge/refund, webhook | Completes the full saga with compensation. |
| **4 · Catalog** | products/comments/discounts + Order's `catalog_read_model` projection (consume `ProductCreated`/`PriceChanged`) | Decouples checkout from Catalog via events. |
| **5 · Notification** | consume order/catalog events (Kafka) → dispatch email/push via RabbitMQ + DLQ + retry | RabbitMQ showcase. |
| **6 · Identity + Gateway** | auth/rbac extracted; Gateway verifies the **httpOnly-cookie JWT**, sets/refreshes it, enforces CSRF on mutations, and **routes REST + proxies the SSE order stream** to all services | Front door built last, once services exist. |
| **7 · System hardening & verification** | System-wide **Prometheus + Grafana** dashboards + SLO alerting, OpenTelemetry + Jaeger tracing, **k6 load tests** + **chaos suite** (kill a broker/service mid-saga), orchestrated-saga variant (comparison), schema-evolution `v2` event | Prove the whole system meets its SLOs and recovers from failure. (Per-service observability/resilience already ships in each phase via the DoD.) |
| **8 · Storefront** | Customer-facing SPA (`apps/web`, Vite + React + TS + Tailwind) — catalogue, cart, authed checkout, and a live **order-pipeline tracker** that visualizes the saga. Talks only to the Gateway; imports DTOs + zod from `contracts`. | Puts a human face on the system and drives the whole saga from the shopper's side. Built last, once the services + Gateway exist. |

## Phase 8 · Storefront (design)

The one **frontend** in the build (see scope change below). A thin client — the
backend stays the star. Depends on Phases 1–6 (needs Catalog, Order, Payment,
Identity, and the Gateway edge live).

**Stack:** `apps/web/` — Vite + React 18 + TypeScript + Tailwind. React Router,
React Query for server state. Talks **only to the Gateway** over REST (decision
#7 — never to services directly).

**No contract drift:** the storefront imports DTO types + zod schemas from
`packages/contracts` and validates every Gateway response at the boundary — the
same single source of truth the services use.

**Sync read surface (the storefront's backend contract).** The saga is async
choreography, but the storefront needs synchronous reads and live status. All of
it is served at the **Gateway edge** (decision #7), never service-direct:
- **Catalogue** — `GET /products`, `GET /products/:id` → routed to **Catalog**.
- **Cart / checkout** — `GET`/`POST /cart`, `POST /orders` → routed to **Order**.
- **Order status (live)** — **Server-Sent Events**: `GET /orders/:id/stream`,
  exposed by **Order** (which owns order state) and proxied by the Gateway. Order
  emits one SSE frame per saga transition (PENDING → InventoryReserved →
  PaymentSucceeded → CONFIRMED, plus the compensation path) straight off its state
  machine. Degrades to `GET /orders/:id` polling if SSE is unavailable.

Why SSE over WebSocket/poll: order status is **one-way server→client**,
short-lived, and `EventSource` carries the auth **cookie** automatically (no custom
header) — it pairs exactly with the httpOnly-cookie auth below. WebSocket's full
duplex is unused weight against a stateless Gateway; polling is the degraded
fallback, not the primary. (This SSE endpoint + read API are a **forward
dependency on Phase 2 (Order) and Phase 6 (Gateway)** — see their rows.)

**Flows**
- **Auth** — login + register via Identity. The Gateway sets the JWT as an
  **httpOnly, Secure, SameSite cookie**; the SPA never touches the token in JS
  (XSS-safe). Mutations carry a **CSRF token** (double-submit) since cookies
  auto-send. Refresh is handled Gateway-side.
- **Catalogue** — home/grid + product detail (Catalog).
- **Cart** — add/remove/quantity (Order's cart).
- **Checkout** — place order → opens the saga; the **order-status page renders the
  choreographed pipeline live** (PENDING → InventoryReserved → PaymentSucceeded →
  CONFIRMED), including the compensation path (payment fails → OrderCancelled →
  inventory released).
- **Order history** (authed).

**Design language:** modern-minimal, soft (Apple/Google-modern) — rounded elevated
cards, soft shadows, light-gray ground / white surfaces, system sans for reading,
**mono for every datum** (prices, SKUs, order IDs, saga states). Color is reserved
to encode order/saga state (amber = in-progress, green = confirmed, red =
cancelled). The **order-pipeline tracker is the signature element**. Approved
clickable prototype (design reference only — throwaway HTML, not the React code):
`https://claude.ai/code/artifact/d172bc7c-53ef-4d86-9872-a7e89f2bf48e`.

**Still owed:** Phase 8 gets its **own child spec → plan** (per the umbrella's
per-phase cycle) before implementation. React version tracks the latest (18/19) at
build time. Playwright (frontend e2e) joins the Testing inventory above.

**Storefront Definition of Done**
- [ ] Talks only to the Gateway; DTOs imported from `contracts`; responses zod-validated.
- [ ] `apps/*` added to `pnpm-workspace.yaml`; `packages/contracts` builds **dual
      ESM+CJS** so the ESM/Vite app can import the (CJS) contracts cleanly.
- [ ] Env-based config (Gateway URL); zero secrets in the bundle.
- [ ] Loading / error / empty state for every async view.
- [ ] Auth: login/register via Identity; JWT in an **httpOnly Secure SameSite
      cookie** (never in JS); **CSRF token** on mutations; protected routes.
- [ ] Live order status over **SSE** (`GET /orders/:id/stream`), polling fallback.
- [ ] Responsive; basic a11y (keyboard focus, labels, contrast); `prefers-reduced-motion` honored.
- [ ] Component tests (Vitest + RTL) + one Playwright e2e (browse → cart → checkout → confirmed).
- [ ] Multi-stage Dockerfile; served static; runs in the compose prod profile.

## Out of scope (for now)

Production-grade *engineering quality* is in scope (decision #11) and runs locally.
What stays out:

- Real payment provider / real money (simulated gateway only; Stripe test-mode is
  an optional later swap).
- Kubernetes / cloud deployment / managed services (local docker-compose only —
  the prod compose profile builds and runs the service images, but there is no
  cloud target, no HA/autoscaling, no managed Postgres/Kafka).
- Real secrets manager (env / gitignored `.env` only).
- Admin / internal ops UI. A **customer storefront is now Phase 8**; an internal
  ops/observability dashboard stays out — Grafana + Jaeger (Phase 7) cover that.
- Polyglot persistence (all Postgres for this pass; per-workload DB choice is a
  possible future lesson).

## Phase 0 decisions (resolved 2026-07-18)

1. **Postgres:** one container, **one database per service** (separate DBs +
   Prisma schemas, no cross-DB queries). Split to per-container later if the
   isolation-realism lesson is wanted.
2. **Kafka:** **KRaft** mode (no ZooKeeper) — modern, one fewer container.
3. **Workspaces:** **pnpm** — strict, content-addressed store, best ergonomics
   for a many-package TS monorepo.
4. **Outbox relay:** **polling loop** first (teaches the pattern); Debezium /
   logical decoding is a Phase 7 upgrade.
