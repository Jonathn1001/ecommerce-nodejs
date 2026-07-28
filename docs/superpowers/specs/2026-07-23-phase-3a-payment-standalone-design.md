# Phase 3a · Payment service (standalone) — Design (child spec)

> Child spec of the umbrella [`2026-07-18-microservices-streaming-rebuild-design.md`](./2026-07-18-microservices-streaming-rebuild-design.md)
> and the [Phases 3–8 roadmap](./2026-07-23-phases-3-8-roadmap.md). First slice of
> **Phase 3 (Payment)**. Stands up the Payment service far enough to charge a command
> end-to-end **on its own** — no Order integration (that is 3b), no timeout/webhook/refund
> (3c). It also absorbs the first piece of RabbitMQ platform debt: bounded retry on the
> shared command consumer.

## Purpose

The saga's money leg does not exist yet: `ChargePayment` has no consumer, no service
charges anything, and RabbitMQ — fully implemented in `@ecom/shared` and provisioned in
compose/CI — is used by zero services. This slice makes Payment a real, independently
runnable service, exactly how Inventory ran before Order existed: it consumes a
`ChargePayment` command off RabbitMQ, runs a **deterministic simulated gateway**,
persists the payment, and emits `PaymentSucceeded`/`PaymentFailed` to Kafka via the
transactional outbox. Driven by hand-sent commands until 3b wires Order's relay.

## Scope

**In:**
- `services/payment` — service scaffold mirroring `services/inventory` (config, db, app, main, Dockerfile).
- Postgres `payment` database (pre-created by the Phase-0 init script), one Prisma schema, migrations via CLI only.
- **RabbitMQ consumer** on queue `payment.charge` (wrapper auto-creates `payment.charge.dlx` fanout + `payment.charge.dlq`), handling the `ChargePayment` command.
- **Simulated gateway** — a pure `simulateCharge(amount)` core (deterministic; see below).
- Persist `Payment` + `PaymentAttempt`; transactional outbox → Kafka `payment.events`, drained by the shared relay.
- **Idempotency** — `ProcessedEvent` ledger (command `eventId`) + unique `Payment.orderId` (provider idempotency key).
- **Platform change (absorbed):** bounded retry in `@ecom/shared` `consumeCommands` (today: one throw → straight to DLQ).
- New contracts `events/payment.ts`: `CHARGE_PAYMENT`, `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED`.
- `GET /payments/:orderId` for demo observability; inherited `/healthz`+`/readyz`.
- Per-service Definition of Done: zod config, health, graceful shutdown, multi-stage Dockerfile + `app` compose profile, hand-added CI integration step.

**Out (deferred — YAGNI):**
- **Order integration** — Order enqueuing `ChargePayment` and consuming `payment.events`; the `AWAITING_PAYMENT → CONFIRMED/CANCELLED` transitions; Inventory `CONSUMED` status. → **3b**.
- **Timeout outcome, provider webhook, refund** (`PAYMENT_REFUNDED`). → **3c**.
- Real payment provider (locked: simulated), multi-currency, partial capture.
- Auth on any endpoint (`ChargePayment` is an internal command; `GET /payments/:orderId` is a demo surface until the gateway fronts it).

## Simulated gateway (deterministic — "magic amounts")

A pure core (mirrors `inventory/reserve.ts`'s transport-free style):

```
simulateCharge(amount: number): "SUCCEEDED" | "FAILED"
  amount % 100 === 1   -> "FAILED"      -- the "declined" magic value
  amount % 100 === 99  -> reserved for "TIMEOUT" (documented; wired in 3c, NOT here)
  else                 -> "SUCCEEDED"
```

- **Amount is integer minor units** (project convention). A test forces a decline by
  seeding a product/order whose **total** lands on `…01` (e.g. `101`, `2501`); every
  other total succeeds. Mirrors real payment sandboxes (Stripe magic amounts / test
  cards): the contract carries no test-control field, and **Order never knows** — it
  sends the real amount, the gateway rule is Payment's private business.
- Deterministic ⇒ reproducible happy-path and forced-failure tests without randomness.
- 3a implements only SUCCEEDED/FAILED; the `…99` timeout branch is reserved and
  documented so 3c is a pure addition, not a rewrite.
- **Consequence — any total `≡ 1 (mod 100)` always declines** (`1`, `101`, `2501`, …),
  including a legitimate order that happens to end in `…01`, and the 1-minor-unit edge
  (`amount === 1` → FAILED). This is the intended magic-amount behaviour: **demo/seed
  prices must avoid `…01` endings unless deliberately exercising the decline path.**

## Contracts (`packages/contracts/src/events/payment.ts`, new)

- `CHARGE_PAYMENT = "payment.charge"` — the **RabbitMQ command**. Payload
  `ChargePaymentPayloadSchema { orderId: string.min(1), amount: number.int().positive() }`.
- `PAYMENT_SUCCEEDED = "payment.succeeded"` — Kafka event. Payload
  `{ orderId: string, paymentId: string, amount: number.int().positive() }`.
- `PAYMENT_FAILED = "payment.failed"` — Kafka event. Payload `{ orderId: string, reason: string }`.
- `PAYMENT_REFUNDED` is introduced by 3c, not here.
- Wire the new file into `contracts/src/index.ts`. Payload style mirrors `events/inventory.ts`
  (orderId-keyed, minimal).

**Topics/queues:** command queue `payment.charge`; the outbox relay maps `payment → payment.events`
via `topicFor(aggregateType)` (Payment is the sole producer on `payment.events`). Kafka events are
keyed by `envelope.eventId` (existing `createProducer.publish` behaviour — not changed here; the
key-by-aggregate concern is a platform item, not 3a).

## Data model (Postgres `payment` database)

One additive schema, migrations via `prisma migrate dev` only. Convention: PascalCase models,
camelCase fields, no `@map`; amounts are integer minor units.

- **`Payment { id String @id @default(uuid()); orderId String @unique; amount Int; status String; createdAt DateTime @default(now()); updatedAt DateTime @updatedAt }`**
  — `status` ∈ `SUCCEEDED | FAILED` (terminal; the 3a charge is synchronous). **`orderId @unique`
  is the provider idempotency key** — at most one payment per order, so a retried command cannot
  double-charge. (3c's async timeout will add a `CHARGING` interim state; not needed while charging is sync.)
- **`PaymentAttempt { id String @id @default(uuid()); paymentId String; outcome String; createdAt DateTime @default(now()); payment Payment @relation(fields:[paymentId], references:[id], onDelete: Cascade) }`**
  with `@@index([paymentId])` — one row per gateway call. In 3a there is exactly one attempt per
  payment; the table exists because 3c's retry/webhook path appends attempts.
- **`ProcessedEvent { eventId String @id; type String; processedAt DateTime @default(now()) }`** — exact shape from inventory/order.
- **`Outbox {...}`** — exact shape from inventory/order (`id, aggregateType, aggregateId, type, version, traceId, producer, payload, occurredAt, sentAt`, `@@index([sentAt])`).

## Command handler flow (`handleChargePayment`, one tx)

Thin orchestrator (mirrors `inventory/consumer.ts`): parse the envelope, open one
`prisma.$transaction`, call the pure gateway core + persist over a tx-bound port.

```
handleChargePayment(env):                        -- env.type === CHARGE_PAYMENT
  { orderId, amount } = ChargePaymentPayloadSchema.parse(env.payload)
  return prisma.$transaction(tx =>
    if not tx.markProcessed(env.eventId, env.type): return "DUPLICATE"     -- command redelivery
    if tx.paymentExists(orderId):                 return "ALREADY_CHARGED" -- provider idempotency
    outcome = simulateCharge(amount)              -- pure core
    paymentId = tx.createPayment(orderId, amount, outcome)
    tx.createAttempt(paymentId, outcome)
    if outcome == "SUCCEEDED":
      tx.enqueue(PAYMENT_SUCCEEDED, orderId, { orderId, paymentId, amount })
    else:
      tx.enqueue(PAYMENT_FAILED, orderId, { orderId, reason: "CARD_DECLINED" })
    return outcome
  )
  log("charge_handled", { orderId, outcome, traceId })   -- returns void; see below
  -- tx commits, THEN the rabbit consumer acks the command
```

The outcome string is **for logging/tests only**: `consumeCommands` types the handler as
`(env) => Promise<void>` and acks on no-throw — it does **not** branch on the return. So
`handleChargePayment` logs the outcome (ids only) and returns void, exactly like
`services/inventory/src/consumer.ts`. `CHARGE_PAYMENT`'s value (`"payment.charge"`) is
intentionally the same string as the queue name — different namespaces (event type vs
queue), equal by convention; not a collision.

- **Belt-and-suspenders idempotency:** `ProcessedEvent` (command `eventId`, `markProcessed` via
  `createMany + skipDuplicates`) **and** unique `Payment.orderId`. A redelivered `ChargePayment`
  after commit-but-before-ack hits `DUPLICATE`; a genuinely re-sent command for an already-charged
  order hits `ALREADY_CHARGED` — either way, one charge, one event.
- **State + emitted event are atomic** via the outbox (the dual-write is solved exactly as elsewhere);
  the RabbitMQ ack is the only at-least-once surface, covered by the dedup above.
- **Business outcomes never throw:** `DUPLICATE`/`ALREADY_CHARGED`/`SUCCEEDED`/`FAILED` all *return*,
  so the command acks normally and never reaches the DLQ. Only an infra fault (DB down, parse failure)
  throws → retry → DLQ.

## Platform change — bounded retry in `consumeCommands` (`packages/shared/src/rabbitmq.ts`)

Today `consumeCommands(queue, handler)` parses → runs the handler → `ack`; any throw →
`nack(msg, false, false)` → straight to DLQ, **no retry**. A transient DB blip would poison-class a
legitimately retryable command.

Change: wrap the handler in `withRetry` (mirrors `kafka.ts` `run`'s `{ maxRetries = 3 }` + backoff);
`nack` → DLQ **only after retries are exhausted**. Signature gains an optional
`opts: { maxRetries?: number }`, defaulting to preserve call-site simplicity. This is a reusable
platform improvement (Phase 5's `SendEmail` worker inherits it). Idempotency stays the **caller's**
responsibility (as with the Kafka consumer) — the wrapper adds retry, not dedup.

Its own `packages/shared` test gains a case: a handler that throws N< maxRetries times then succeeds
is retried to success (not DLQ'd); a handler that always throws lands in `${queue}.dlq` after the bound.

## Configuration & inherited Definition of Done

Fail-fast zod config (via `@ecom/shared`): `DATABASE_URL`, `RABBITMQ_URL`, `KAFKA_BROKERS`, `PORT`,
`LOG_LEVEL`. **No `REDIS_URL`** — idempotency is Postgres (`ProcessedEvent` + unique constraint), and
there is no lock (no concurrent shared resource; one payment per order is enforced by the unique key).

- **`main.ts`** wires both transports: `createKafka("payment") → createProducer → connect`, outbox
  relay (`payment → payment.events`); `createRabbit() → assertWorkQueue("payment.charge") →
  consumeCommands("payment.charge", handleChargePayment, { maxRetries: 3 })`. Graceful shutdown
  (reverse teardown): HTTP server drains first → rabbit `close()` → relay `stop()` →
  producer `disconnect()` → `prisma.$disconnect()` last.
- **`/healthz`** + **`/readyz`** — `createHealthRouter({ db, rabbit })`, probing Postgres **and
  RabbitMQ**. This **deliberately diverges** from the inventory/order convention (db-only): Payment's
  entire purpose is consuming commands off `payment.charge`, so a RabbitMQ-unreachable instance is not
  ready even though its DB is fine — reporting "ready" while it can charge nothing would be wrong for
  the money leg. (Kafka is still not probed — the outbox relay tolerates a Kafka blip by leaving rows
  unsent; the command intake does not.)
- **`db.ts`** loads this service's `.env` then constructs `PrismaClient` from `./generated/prisma`
  (custom per-service output, gitignored) — the inventory/order pattern, not `@prisma/client`.
- Plain express + zod `safeParse` at the edge; `traceMiddleware` in front.
- Multi-stage Dockerfile + a `payment` entry under the `app` compose profile (build context `.`,
  DB `postgres:5432/payment`, `RABBITMQ_URL`, `KAFKA_BROKERS`, port), mirroring `services/inventory`.
- **CI:** add a hand-written `integration`-job step (the job is not service-generic): `prisma migrate
  deploy` against `DATABASE_URL=…/payment` + `pnpm vitest run services/payment`. The `quality` job
  auto-globs `./services/*` — no change there.

## Known limitations (intentional, this slice)

1. **No Order integration.** `ChargePayment` is hand-sent (test/script) until 3b wires Order's
   outbox→Rabbit relay; `payment.events` has no consumer yet. Same posture as Inventory pre-Order.
2. **Synchronous charge only.** The gateway resolves in-handler; no `CHARGING` interim state, no
   timeout, no provider webhook — 3c adds those (and the `…99` magic value).
3. **No refund.** `PAYMENT_REFUNDED` + the admin refund stub are 3c.
4. **Kafka events keyed by `eventId`, not aggregate.** Existing platform behaviour (`createProducer.publish`);
   partition-by-orderId is a platform concern, not fixed here.
5. **`GET /payments/:orderId` is unauthenticated** — a demo/observability surface until the gateway (Phase 6) fronts it.
6. **The charge amount is trusted from the command.** Payment charges exactly the `amount` in
   `ChargePayment` with no cross-check against the order — correct under DB-per-service (Order is the
   pricing authority and owns the total; Payment never reads Order's DB). Documented so it reads as an
   intentional property, not a missing validation.

## Testing (TDD)

- **Unit** — `simulateCharge`: `amount % 100 === 1` → `"FAILED"` (e.g. 101, 2501); everything else →
  `"SUCCEEDED"` (e.g. 100, 2500, 199); confirm `…99` is currently treated as SUCCEEDED (timeout not yet wired).
- **Integration** (compose stack — real Postgres + RabbitMQ): send a `ChargePayment` via
  `sendCommand("payment.charge", makeEnvelope(...))` →
  - success amount → one `Payment(status=SUCCEEDED)` + one `PaymentAttempt` + one `PAYMENT_SUCCEEDED` outbox row;
  - `…01` amount → `Payment(status=FAILED)` + one `PAYMENT_FAILED` outbox row;
  - **duplicate command `eventId`** → second delivery `DUPLICATE`: still one payment, one `ProcessedEvent`, no second outbox row;
  - **re-sent command, same `orderId`, new eventId** → `ALREADY_CHARGED`: still one payment;
  - **injected-throw handler** → retried `maxRetries` times then the raw command lands in `payment.charge.dlq` (assert via `consumeDlqOnce`).
- **Slice e2e** (real RabbitMQ + Kafka): hand-send a `ChargePayment`, run the outbox relay, assert a
  `PaymentSucceeded` (and, for a `…01` order, `PaymentFailed`) envelope arrives on `payment.events`.

## Definition of Done

- `services/payment` consumes `payment.charge`, charges via the deterministic gateway, persists
  `Payment` + `PaymentAttempt`, and emits `payment.events` via outbox.
- Idempotency proven: duplicate command and re-sent-same-order both yield exactly one charge/event.
- `consumeCommands` retries then DLQs on exhaustion; a poison command demonstrably lands in `payment.charge.dlq`.
- Inherited DoD satisfied (zod config, health, graceful shutdown, Dockerfile + `app` compose entry, CI step).
- Unit + integration + slice-e2e green.

## Open questions

None blocking. Resolved in brainstorming 2026-07-23: gateway determinism = **magic amounts** (rule on
the minor-units total, `…01` declines; no test-control field on the contract; timeout `…99` reserved
for 3c); Rabbit retry lands in the **shared `consumeCommands`** (reusable), idempotency stays
caller-side; belt-and-suspenders dedup = `ProcessedEvent` + unique `Payment.orderId`; charge is
synchronous this slice (`CHARGING`/timeout/webhook/refund all deferred to 3c).

Design review (review-design-plan, 2026-07-23) resolved two forks: **`PaymentAttempt` is built in 3a**
(the umbrella lists `payment_attempts`; it's written in the same handler tx at zero extra cost and
avoids a 3c migration — 3a always writes exactly one row, 3c appends), and **`/readyz` probes RabbitMQ**
in addition to Postgres (justified divergence from the db-only convention — see Configuration). Also
folded: the magic-amount `…01` demo caveat, the trusted-amount property (Known-limitation #6), and the
handler-returns-void clarification.
