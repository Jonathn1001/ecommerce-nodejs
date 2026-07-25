# Phase 5 · Notification (RabbitMQ showcase) — Design (child spec)

> Combined Phase-5 spec (user decision): shared rabbit-adapter hardening **first**, then
> the `notification` service (dispatcher + worker + mailpit + DLQ replay). Reference:
> `docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md` (Phase 5). Touches **shared**
> (rabbit), **Order** (events +`userId`), **infra** (mailpit), plus the new service.

## Purpose

1. **Harden the shared rabbit adapter** (`createRabbit`) so the second consumer/producer
   doesn't inherit its gaps: `prefetch` back-pressure, boot-time connect retry
   (non-fatal), and a documented liveness-restart contract for mid-life drops.
2. **`services/notification`:** Kafka consumer on `order.events` → a `Notification` row +
   a `SendEmail` command (via the Phase-3 outbox→Rabbit relay) → a worker that renders +
   sends via **nodemailer → mailpit**. **DLQ replay is the headline lesson** (documented +
   demoed).
3. **Widen `order.events` with `userId`** so the dispatcher can synthesize a recipient
   (no Identity service until Phase 6).

## Scope

**In scope**
- `packages/shared/src/rabbitmq.ts`: `prefetch`, boot-retry, non-fatal degraded start,
  liveness-restart contract. A when-to-use-which dedup note (`ProcessedEvent` vs Redis).
- `packages/contracts/src/events/order.ts` + `services/order`: `userId` on
  `OrderPlaced`/`OrderConfirmed`/`OrderCancelled`.
- `services/notification`: `Notification`/`Outbox`/`ProcessedEvent`; dispatcher; `Mailer`
  port + nodemailer→mailpit; worker; templates; DLQ replay script + runbook.
- `docker-compose.example.yml` (mailpit + notification + **`restart:` on app services**) +
  `.github/workflows/ci.yml` (notification step). `notification` DB already provisioned.

**Out of scope** (explicit)
- Real email provider, push, OTP (Phase 6 if Identity wants verification email).
- Catalog-event notifications (stub the subscription — no `catalog.events` consumer).
- Product names in emails (soft dep on Phase 4 — degrade: orderId only, no `catalog_read_model` read).
- **Full in-process rabbit reconnect** (Phase 7); this pass uses boot-retry + liveness-restart.
- Real recipient addresses (synthetic `<userId>@domain` until Phase 6 Identity).

## A. Rabbit adapter hardening (`packages/shared/src/rabbitmq.ts`) — FIRST

Current `createRabbit` (verified): one `amqp.connect`; on `conn` close/error sets
`healthy=false` but **nothing reconnects**; `consumeCommands` has **no `prefetch`**;
`amqp.connect` at boot **throws** on failure (caller crashes).

- **Prefetch:** after `createConfirmChannel`, `await ch.prefetch(prefetchN)` (param, default
  10) — bounds unacked in-flight on every consumer.
- **Boot-retry:** wrap the connect in `withRetry(() => amqp.connect(url), { retries: 5,
  baseMs: 500, label: "rabbit-connect" })` (absorbs broker-starting races).
- **Fail-fast on exhausted boot-retry (decided — simpler than a degraded adapter):** if
  `withRetry` exhausts, `createRabbit` **throws** (as today) → the process exits → the
  compose **`restart:` policy** re-boots it. Compose already gives every rabbit consumer
  `depends_on: rabbitmq { condition: service_healthy }`, so boot-time-rabbit-down is
  prevented in the run path; the boot-retry only absorbs the brief broker-warming race.
  **No degraded-adapter state; Order/Payment boot behavior is unchanged** (they still get a
  fully-connected adapter or a crash-then-restart).
- **Liveness-restart contract (mid-life drops):** a real drop flips `healthy=false`
  (→ `/readyz` unready) **and exits the process** via `createRabbit`'s `onConnectionLost`
  (default: log + `process.exit(1)`), so the **`restart:` policy** re-execs it and a fresh
  `createRabbit` re-establishes everything. The exit is load-bearing: a Docker `restart:`
  policy fires on process exit only — an unhealthy healthcheck alone never restarts a
  container (it only gates `depends_on`). A close initiated by our own `close()` is
  exempt, so graceful shutdown does not self-kill. **`docker-compose.example.yml` app services
  gain `restart: unless-stopped`** (none have it today — verified). One recovery mechanism
  (restart) covers both boot-failure and mid-life drops. In-process reconnect (recover
  without a restart) → Phase 7.
- **Signature/back-compat:** `createRabbit(opts?: { prefetch?: number; onConnectionLost?: () => void })`; existing callers
  (Order, Payment) pass nothing → default 10, behavior otherwise unchanged (still throws on
  a connect failure). `sendCommand`/`consumeCommands`/`assertWorkQueue`/`consumeDlqOnce`/
  `checkHealth`/`close` keep their signatures. **Regression gate: Order + Payment suites
  (incl. their rabbit int tests) stay green.**

## B. Order events widened `+userId` (`@ecom/contracts` + `services/order`)

- **Contracts:** `OrderPlacedPayloadSchema`, `OrderConfirmedPayloadSchema`,
  `OrderCancelledPayloadSchema` gain `userId: z.string().min(1)` (required).
- **Emission:** `place-order.ts` (has `userId`) adds it to the `ORDER_PLACED` payload;
  `transition.ts` emits `{orderId, userId}` for `ORDER_CONFIRMED`/`ORDER_CANCELLED` — so
  `TransitionTx.loadOrder` returns `{ status, totalPrice, userId }` (tx-adapter select +=
  `userId`) and `applyResult` threads it into the enqueue.
- **Tests:** `transition.unit.test.ts` + `consumer.int.test.ts` fakes/assertions updated
  for `+userId`. Inventory's `order.confirmed` handler parses only `orderId` — unaffected.
- **Back-compat note:** `userId` is required; a pre-Phase-5 `order.confirmed` without it
  would fail parse → DLQ. Acceptable (fresh deploy; no such events exist locally).

## C. Notification dispatcher (Kafka `order.events` → `services/notification`)

Service structure mirrors payment/catalog (Express + Prisma own DB + outbox relay +
health + graceful shutdown). Config `PORT=3005`, `DATABASE_URL`, `KAFKA_BROKERS`,
`RABBITMQ_URL`, `SMTP_HOST`/`SMTP_PORT` (mailpit), `NOTIFY_EMAIL_DOMAIN` (default
`example.test`), `RABBIT_PREFETCH`.

### Data model (`services/notification/prisma/schema.prisma`)
```prisma
model Notification {
  id        String   @id @default(uuid())
  orderId   String
  userId    String
  type      String                          // order.placed | order.confirmed | order.cancelled
  to        String
  subject   String
  status    String   @default("PENDING")    // PENDING | SENT | FAILED
  createdAt DateTime @default(now())
  sentAt    DateTime?
  @@unique([orderId, type])                 // dispatcher dedup (2nd guard)
}
```
Plus `Outbox` + `ProcessedEvent` (copied from a sibling).

### `handleOrderEvent(env)` (`dispatcher.ts` core + `tx-adapters.ts`)
Consumes the three `order.events` types (ignores others). In one `prisma.$transaction`:
1. `markProcessed(eventId, type)` — Kafka dedup; `false` → return (redelivery).
2. Resolve `to = `${userId}@${NOTIFY_EMAIL_DOMAIN}``; `subject` from `renderTemplate`.
3. `create` the `Notification(PENDING)` — **`create` (not `createMany`) so we get the row
   `id`** for the command payload — inside a `try/catch` on Prisma `P2002` (the
   `(orderId,type)` unique): a duplicate-type → caught → return without enqueuing (no orphan
   `SendEmail`). `markProcessed(eventId)` already absorbs same-event redelivery; this unique
   is the belt-and-suspenders guard for a distinct event hitting the same `(orderId,type)`.
4. Enqueue a **`SendEmail`** outbox row (`aggregateType:"notification"`, `type: SEND_EMAIL`,
   payload `{ notificationId: created.id }`) in the same tx.

The relay (main.ts) routes `SendEmail` → Rabbit `notifications` via the 3b commands
channel: `commands: { sender: rabbit, queueFor: r => r.type === SEND_EMAIL ? "notifications" : null }`;
`order.*`-style rows (none here) would go to Kafka but notification emits only the command,
so `topicFor` is unused-but-present. **`SEND_EMAIL` + `SendEmailPayloadSchema {notificationId}`
are notification-local** (intra-service; not a cross-service contract).

### Templates (`templates.ts`)
`renderTemplate(type, { orderId }): { subject, html }` — a type→content map with template
literals (lean, per roadmap). e.g. `order.confirmed` → `{ subject: "Order <id> confirmed",
html: "<p>Your order <id> is confirmed.</p>" }`. `order.placed` / `order.cancelled`
analogous. No product names (degrade — soft dep on Phase 4).

## D. Notification worker (Rabbit `notifications` queue)

- **`Mailer` port** (`mailer.ts`): `interface Mailer { send(msg: { to: string; subject: string;
  html: string }): Promise<void> }`; `createMailer(config)` → a nodemailer SMTP transport at
  `SMTP_HOST:SMTP_PORT` (mailpit) with **bounded timeouts** (`connectionTimeout`,
  `greetingTimeout`, `socketTimeout` ≈ 5s) so a *hung* mailpit fails fast → retry → DLQ
  rather than blocking the worker. Worker takes a `Mailer` (fake in unit tests).
- **`handleSendEmail(env)`:** parse `{notificationId}`; load the `Notification` row.
  - `status === "SENT"` → **ack+skip** (redelivery/dedup).
  - else `render(type)` → `mailer.send({to, subject, html})` → **CAS** `updateMany({ where:
    { id, status: "PENDING" }, data: { status: "SENT", sentAt: now } })`. A `count 0` means
    a concurrent worker already sent → skip.
  - send throws → `consumeCommands`' `withRetry` retries → exhausted → `nack` →
    `notifications.dlq` (poison). The row stays `PENDING` (a later replay re-sends).
- **Wiring:** the worker runs in the SAME notification process (`main.ts`):
  `rabbit.assertWorkQueue("notifications")` + `rabbit.consumeCommands("notifications",
  handleSendEmail, { maxRetries: 3 })`. `prefetch` (from the hardening) bounds it.
- **Idempotency caveat (documented):** the send is an external side-effect outside the DB
  tx; a crash after `mailer.send` but before the CAS → a redelivery re-sends (rare dup).
  Same class, wider window: amqplib does not await the consume callback, so two *concurrent*
  deliveries of the same SendEmail (relay crash before `markSent`, or two relays running)
  can both read `PENDING` before either CAS → two emails, one CAS winner. No lost email and
  no wedged row either way. At-least-once + best-effort sent-marker (roadmap-accepted).

## E. DLQ replay (the headline lesson)

- **`services/notification/scripts/replay-dlq.ts`:** drain `notifications.dlq`
  (`rabbit.consumeDlqOnce`-style loop or a dedicated consumer) and re-publish each envelope
  to the `notifications` queue via `sendCommand`, then exit. Bounded (drains what's there).
- **Runbook `docs/runbooks/phase-5-notification-demo.md`** demos the loop: place → confirm
  an order → email appears in the mailpit UI (:8025); then **stop mailpit** → confirm
  another order → `mailer.send` fails → after retries the `SendEmail` lands in
  `notifications.dlq` (row stays `PENDING`); **start mailpit** → run `replay-dlq` → the
  email is delivered, row → `SENT`. This is the phase's DoD.

## F. Wiring / infra

- **mailpit** compose service: `axllent/mailpit`, `ports: ["1025:1025","8025:8025"]`,
  healthcheck on `:8025`. Under the `app` profile (or infra — it's a dependency of
  notification; put it beside rabbitmq so it's up for the notification worker).
- **notification** compose entry (`app` profile): own Dockerfile (clone payment's),
  `DATABASE_URL=…/notification`, `KAFKA_BROKERS`, `RABBITMQ_URL`, `SMTP_HOST=mailpit
  SMTP_PORT=1025`, `NOTIFY_EMAIL_DOMAIN`, `PORT 3005`; `depends_on` postgres+kafka+rabbitmq
  (+mailpit) healthy; healthcheck `/readyz`; **`restart: unless-stopped`**.
- **`restart: unless-stopped` added to ALL app services** (hello/inventory/order/payment/
  catalog/notification) — the liveness-restart contract (A) depends on it.
- **CI:** a `Notification service` step (`DATABASE_URL=…/notification`, `KAFKA_BROKERS`,
  `RABBITMQ_URL`; `prisma migrate deploy` then `pnpm vitest run services/notification`).
- **Dependencies:** `nodemailer` (+ `@types/nodemailer`) in `services/notification`.

## Configuration & inherited Definition of Done

- Money n/a. **Logging ids-only** — notification id/orderId/userId/type/traceId; **NEVER
  the recipient address, subject, or rendered body** (PII risk — roadmap-flagged).
  Prisma PascalCase/camelCase/no `@map`. Migrations CLI-only. Per-service dotenv gitignored
  (inline `DATABASE_URL` in tests).

## Design decisions (resolved)

- **Combined spec, rabbit-hardening first** (Q1).
- **Rabbit = prefetch + boot-retry + fail-fast + liveness-restart contract** (Q2, simplified
  in design review — dropped the degraded-adapter; one recovery mechanism = container
  restart, no Order/Payment boot-behavior change); full reconnect → Phase 7; app services
  gain `restart:`.
- **Dedup = Postgres throughout** (Q3): dispatcher `ProcessedEvent` + unique `(orderId,type)`
  same-tx; worker notification-row status CAS `PENDING→SENT`. No Redis.
- **Recipient = synthetic `<userId>@NOTIFY_EMAIL_DOMAIN`** (Q4), stored on the row.
- **`userId` widened onto all 3 `order.events`** (Q5); required.
- **Single `notifications` queue** (not per-type routing); **`SendEmail` notification-local**
  (intra-service); **Mailer port** (nodemailer→mailpit, swap seam for Phase 6+).
- **Shared dedup note:** default Postgres `ProcessedEvent` (same-tx, transactional with a DB
  write); Redis `markProcessed` (`packages/shared/src/redis.ts:45`) only for stateless/
  high-volume dedup with no DB write to bind to — currently unused. Add as a doc-comment in
  `shared` (closes the roadmap's "two mechanisms, zero guidance" debt).

## Known limitations (intentional)

1. No auth on notification's HTTP surface (health only; no business endpoints) — n/a.
2. Synthetic recipients; no real addresses until Phase 6 Identity.
3. No in-process rabbit reconnect — recovery is by container restart (Phase 7 upgrade).
4. Crash-after-send-before-mark → rare duplicate email (at-least-once).
5. No product names in emails (Phase-4 soft dep degraded).
6. Dispatcher + worker in one process (fine for the demo; a worker fleet is a scaling concern).
7. The relay needs a Kafka `producer` + `topicFor` in its signature, but notification emits
   only the Rabbit `SendEmail` command → it connects an idle Kafka producer it never
   publishes through. Harmless; a `commands-only` relay config is a later `shared` follow-up.

## Testing (TDD)

- **Rabbit hardening (shared int, needs rabbit):** `prefetch` bounds unacked (publish N+
  slow-ack, assert ≤ prefetch in flight); boot-retry (connect eventually succeeds via
  `withRetry`); on an unreachable broker `createRabbit` **throws** after the retries
  (fail-fast — assert the rejection). **Regression: `services/order services/payment
  packages/shared` green** (the shared change).
- **Order widening (unit/int):** transition emits `{orderId,userId}`; `loadOrder` returns
  userId; contract tests for the widened payloads.
- **Dispatcher (unit + int):** `handleOrderEvent` dedups on eventId AND `(orderId,type)`;
  creates one `Notification(PENDING)` + one `SendEmail` outbox row; a redelivery → no
  second row. Recipient = `<userId>@domain`.
- **Worker (unit + int):** `handleSendEmail` sends via a fake `Mailer` then CAS `→SENT`; a
  redelivery of a `SENT` row → ack+skip (no second send); a throwing `Mailer` → the row
  stays `PENDING` and (int, real rabbit) the message lands in `notifications.dlq`.
- **e2e (per-leg + manual):** inject `order.confirmed` on Kafka → dispatcher → relay →
  worker → **assert the email via the mailpit HTTP API** (`GET :8025/api/v1/messages`).
  The full DLQ-replay loop = the **manual runbook** (mailpit-down → dlq → replay → sent).
- **Regression gate (per-service):** `notification order payment inventory catalog shared`
  green (the known 3a-sweeper caveat noted).

## Definition of Done

- Place → confirm an order → an "order confirmed" email is visible in the mailpit UI, sent
  to `<userId>@example.test`; the `Notification` row is `SENT`.
- With mailpit down, the `SendEmail` lands in `notifications.dlq` (row `PENDING`); starting
  mailpit + running `replay-dlq` delivers it (row `SENT`) — per the runbook.
- Duplicate `order.events` / redelivered `SendEmail` never produce a duplicate row or a
  second email (modulo the documented crash window).
- Order + Payment suites green after the shared rabbit change; ids-only logging (no
  recipient/body); typecheck + format clean.

## Open questions

1. **`prefetch` default** — 10 (a param; per-service override later if a fleet needs tuning).
2. **mailpit placement** — infra vs `app` profile (spec: beside rabbitmq so it's up for the
   worker; the plan picks one).
3. **Forcing the poison for the DLQ demo** — mailpit-down (transient, chosen) vs a
   bad-template notification; the runbook uses mailpit-down (cleaner recover-and-replay).
