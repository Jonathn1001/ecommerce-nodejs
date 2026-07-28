# Phase 3c · SSE stream + async webhook/timeout + refund stub — Design (child spec)

> Last slice of Phase 3. The saga already closes end-to-end synchronously
> (`PENDING → AWAITING_PAYMENT → CONFIRMED/CANCELLED`, reservation `CONSUMED`)
> after 3b. This slice adds: a live SSE order-status stream, an **asynchronous**
> payment resolution path (the `%100==99` "timeout" outcome resolved by an inbound
> provider webhook), and an admin refund stub. Reference:
> `docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md` (Phase 3, slice 3c).

## Purpose

Three loosely-coupled additions, one spec (user decision — closes Phase 3):

1. **SSE** `GET /orders/:id/stream` (Order) — one frame per state transition, so a
   client watches an order progress live.
2. **Async webhook/timeout** (Payment) — `%100==99` amounts no longer resolve
   synchronously: Payment records `PROCESSING` and emits nothing until an inbound
   `POST /webhooks/payment` finalizes it → `payment.succeeded`/`failed`.
3. **Refund stub** (Payment) — `POST /admin/payments/:orderId/refund` marks a
   `SUCCEEDED` payment `REFUNDED` and emits `payment.refunded`. No consumer.

## Scope

**In scope**
- Order: `GET /orders/:id/stream` (SSE); a `NOTIFY` in the transition tx; a
  dedicated `LISTEN` connection + an in-process subscriber registry; shutdown wiring.
- Payment: `simulateCharge` widened to `PROCESSING`; `chargeOrder` PROCESSING branch
  (record, emit nothing); `POST /webhooks/payment` (finalize a PROCESSING payment);
  `POST /admin/payments/:orderId/refund` (refund stub).
- Contracts: `PAYMENT_REFUNDED` + payload schema.
- Schema comments: `Payment.status` / `PaymentAttempt.outcome` gain `PROCESSING`,
  `REFUNDED` (String columns — comment-only migration, as 3b's `CONSUMED`).

**Out of scope** (explicit)
- **Auth / signature on any endpoint** — SSE, webhook, and admin refund are all
  unauthenticated (Phase 6 gateway; webhook HMAC → Phase 6/7). Documented limitation.
- **Order-side auto-cancel at AWAITING_PAYMENT expiry** and refund-on-late-success
  compensation → Phase 7 (user decision: TTL ≫ saga p99 makes the TTL race
  unreachable in practice; keep the 3b warn-guard).
- **Any consumer of `payment.refunded`** — Order/Inventory do not react; no Order
  `REFUNDED` status, no inventory restock (roadmap scope-out: "refund flow beyond a
  stub").
- **SSE frame DTO in `@ecom/contracts`** — the frame is an HTTP concern, kept inline
  in Order (roadmap parks the contracts DTO for Phase 8).
- **`Last-Event-ID` replay** — reconnect re-reads current status (status is a
  projection, not an event log).

## SSE stream (`services/order`)

### Transition observation — Postgres `LISTEN/NOTIFY`

The consumer that applies a transition may be a different Order process than the one
holding the SSE connection, so an in-process `EventEmitter` is insufficient (user
decision). `LISTEN/NOTIFY` is cross-instance correct with no new infrastructure.

- **NOTIFY (write side, no new dependency):** inside the existing transition
  `prisma.$transaction` (`services/order/src/consumer.ts` `handleEvent` →
  `applyResult` → `transitionTx`), add a port method that runs
  the **tagged-template** `tx.$executeRaw` (bound parameter — never
  `$executeRawUnsafe`) → `SELECT pg_notify('order_status', ${payload})` where
  `payload = json {orderId, status}`. `NOTIFY` inside a transaction is delivered
  **on commit**, never on rollback — so it is exactly as atomic as `setStatus`.
  `tx.$executeRaw` is available on Prisma's `TransactionClient` (the project already
  uses `prisma.$queryRaw` for health probes — `services/order/src/app.ts:35`).
  Order creation (`tx-adapters.ts:20`, status `PENDING`) does **not** NOTIFY — the
  SSE initial frame covers the current state on connect.

- **LISTEN (read side, NEW dependency):** Prisma cannot hold a `LISTEN` — it pools
  connections and never surfaces async notifications. Add **`pg` (node-postgres)** to
  `services/order` for one long-lived dedicated client that `LISTEN order_status`.
  It reads `DATABASE_URL` (same env Prisma uses, loaded in `db.ts`). Encapsulated in a
  new `services/order/src/sse-listener.ts` (a `createOrderListener()` that owns the
  `pg.Client`, the registry, and fan-out). *(Alternative considered: a shared
  `@ecom/shared` helper — deferred; only Order needs it now.)*

- **Listener resilience — fail-fast liveness-restart (decided):** a dropped `LISTEN`
  connection (PG restart, network blip) would otherwise silently stop every stream
  while `/readyz` (Postgres-only, via Prisma's pool) stays green. On the `pg.Client`
  `'error'`/`'end'` event the listener logs `sse_listener_down` (ids-only) and the
  process **exits non-zero** — the compose `restart` policy brings it back and streams
  re-establish on client auto-reconnect. This is the same "reconnect OR document a
  liveness-restart contract" choice the roadmap made for the rabbit consumer;
  in-process **reconnect-without-restart is a Phase-5 resilience-pass upgrade**
  (alongside the rabbit sender/boot-retry item already parked there). Open SSE
  responses are ended on the way down.

### Fan-out — one LISTEN connection per process

A single `pg.Client` per Order process; an in-process registry `Map<orderId, Set<res>>`.
On a notification, parse `{orderId, status}` and write a frame only to that order's
subscribers. Scales to many concurrent streams on one connection (vs. one `LISTEN`
connection per stream).

### Endpoint `GET /orders/:id/stream` (`services/order/src/app.ts`, beside `GET /orders/:id`)

1. Read the order once. **404** if unknown.
2. Set SSE headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`,
   `Connection: keep-alive`), flush.
3. **Register** `res` in the registry under `orderId`, then send the **initial frame**
   = current status. (Registering before the read means a transition landing during
   the read is still delivered; a rare initial==first-notify overlap is idempotent —
   the client dedups by status.)
4. Stream subsequent transitions via the registry fan-out.
5. On a **terminal** status (`CONFIRMED` | `CANCELLED`), send the frame then `res.end()`
   and unregister.
6. **Heartbeat:** a `:keepalive\n\n` comment every 15s (keeps proxies/connections alive,
   detects dead peers).
7. On request `close`, unregister `res`.

**Frame:** `event: status\ndata: {"orderId":"o1","status":"CONFIRMED"}\n\n`. No `id:`
line (no `Last-Event-ID` replay).

### Wiring (`services/order/src/main.ts`)

`createOrderListener()` connects at boot (after `prisma`, before/independent of the
consumer). Teardown: SSE responses closed and the `pg.Client` ended **before**
`prisma.$disconnect`. The current shutdown array (executed in reverse; effective order
`server.close → consumer.disconnect → relay.stop → rabbit.close → producer.disconnect
→ prisma.$disconnect`) gains a `listener.close()` step positioned so open streams end
right after `server.close` and the `pg.Client` closes just before `prisma.$disconnect`.
`GET /readyz` stays Postgres-only (unchanged) — the SSE listener is not a readiness
probe (consistent with the outbox/consumer, which also are not). An unrecoverable
listener error is handled by the fail-fast liveness-restart contract above (process
exits → container restarts), not by flipping readiness.

## Async webhook / timeout path (`services/payment`)

### Gateway widened (`services/payment/src/charge.ts`)

`simulateCharge(amount): "SUCCEEDED" | "FAILED" | "PROCESSING"`:
- `amount % 100 === 1` → `FAILED`
- `amount % 100 === 99` → `PROCESSING` (was reserved/"currently succeeds")
- else → `SUCCEEDED`

`ChargeOutcome` gains `"PROCESSING"`. In `chargeOrder`, the `PROCESSING` branch:
`createPayment(orderId, amount, "PROCESSING")` + `createAttempt(paymentId, "PROCESSING")`
and **emits no event**. The consumer (`handleChargePayment`) logs
`payment_awaiting_webhook` (ids-only). Idempotency is unchanged (markProcessed-first +
unique `Payment.orderId` — `charge.ts`): a redelivered `ChargePayment` for a PROCESSING
order is `DUPLICATE`/`ALREADY_CHARGED`.

### Webhook `POST /webhooks/payment` (`services/payment/src/app.ts`)

Body (zod): `{ orderId: string, outcome: "SUCCEEDED" | "FAILED" }`. A body that fails
the schema → **400** (parity with the other Payment routes).
- Load `Payment` by `orderId`. **404** if none.
- Finalize in one `prisma.$transaction` using a **compare-and-set**, NOT read-then-write:
  `updateMany({ where: { orderId, status: "PROCESSING" }, data: { status: outcome } })`.
  **The webhook is a concurrent HTTP endpoint** — unlike the saga consumer it is not
  serialized per partition, so two simultaneous POSTs (or a `SUCCEEDED`+`FAILED` race)
  must not both emit. The CAS is the guard: if `count === 0` the payment was already
  finalized (or never `PROCESSING`) → **idempotent no-op, 200**, no attempt, no event.
  Only when `count === 1` do we `createAttempt(paymentId, outcome)` and enqueue
  `payment.succeeded`/`payment.failed` via the **existing outbox** (`payment.events`).
- Domain core in a new `services/payment/src/webhook.ts`:
  `finalizePayment(tx, { orderId, outcome }): Promise<"FINALIZED" | "NOOP" | "NOT_FOUND">`
  over a tx-port (`loadPayment(orderId)`, `casStatus(orderId, from, to): Promise<number>`,
  `createAttempt`, `enqueue`), mirroring `charge.ts`'s `ChargeTx` shape.

The saga continues identically to the sync path → Order `CONFIRMED`/`CANCELLED` → SSE
streams it.

### TTL race (resolved: TTL ≫ saga p99)

`RESERVATION_TTL_MS` (compose default `900000` = 15 min) ≫ any demo webhook delay, so
the reservation stays `ACTIVE` when `order.confirmed` reaches Inventory; `CONSUMED`
succeeds. The 3b defensive ACTIVE-guard (warn-log if a confirm finds no ACTIVE
reservation) stays as a backstop. Order-side auto-cancel + refund-on-late-success are a
Phase-7 deferral (roadmap).

## Refund stub (`services/payment`)

### `POST /admin/payments/:orderId/refund` (`services/payment/src/app.ts`)

- Load `Payment` by `orderId`. **404** if none.
- If `status === "REFUNDED"` → idempotent **200** no-op.
- If `status !== "SUCCEEDED"` → **409** (only successful payments refundable; a
  `PROCESSING`/`FAILED` payment cannot be refunded).
- Else one `prisma.$transaction` with the **same compare-and-set** discipline (this is
  also a concurrent HTTP endpoint): `updateMany({ where: { orderId, status: "SUCCEEDED" },
  data: { status: "REFUNDED" } })`. `count === 1` → `createAttempt(paymentId, "REFUNDED")`
  + enqueue `payment.refunded` via outbox (`payment.events`). `count === 0` → a concurrent
  refund already won → idempotent **200**, no second event.
- Domain core `refundPayment(tx, { orderId }): Promise<"REFUNDED" | "NOOP" | "NOT_FOUND"
  | "NOT_REFUNDABLE">` sharing the webhook's tx-port (`loadPayment`, `casStatus`,
  `createAttempt`, `enqueue`) in `services/payment/src/refund.ts`.

**No consumer.** Order's `orderIdOf` (`services/order/src/consumer.ts:21`) returns `null`
for `payment.refunded` → ignored (no-op, no DLQ). Inventory unchanged.

## Contracts (`packages/contracts/src/events/payment.ts`)

Add (mirrors `PaymentSucceededPayloadSchema` = `{orderId, paymentId, amount}`):

```ts
export const PAYMENT_REFUNDED = "payment.refunded" as const;
export const PaymentRefundedPayloadSchema = z.object({
  orderId: z.string().min(1),
  paymentId: z.string().min(1),
  amount: z.number().int().positive(),
});
export type PaymentRefundedPayload = z.infer<typeof PaymentRefundedPayloadSchema>;
```

No new event for the SSE frame (inline in Order). `PROCESSING` is a Payment-internal
status, not an event — no contract.

## Data model

No new tables, no DDL. `Payment.status` comment → `PENDING? | PROCESSING | SUCCEEDED |
FAILED | REFUNDED` and `PaymentAttempt.outcome` comment → `+ PROCESSING | REFUNDED`
(both `String` — `services/payment/prisma/schema.prisma:17,27`). Comment-only migration
via `prisma migrate dev --name payment_processing_refunded` (as 3b's `reservation_consumed`;
if Prisma reports no changes, `--create-only` with the empty SQL to keep `migrate deploy`
in lockstep — document which).

## Configuration & inherited Definition of Done

- New dependency: `pg` (node-postgres) in `services/order` (+ `@types/pg` dev). No new
  env — the listener reuses `DATABASE_URL`.
- No new compose/CI service (webhook + refund are routes on the running Payment;
  the SSE listener uses the existing Postgres). No `RABBITMQ_URL`-style additions.
- Logging ids-only (SSE: log `orderId` + subscriber count; webhook/refund: `orderId`,
  `outcome`, `traceId` — never amounts as PII is n/a, but never the raw body).
- Prisma convention: PascalCase models / camelCase fields / no `@map`.

## Design decisions (resolved)

- **SSE observation = `LISTEN/NOTIFY`** (not in-process emitter, not poll) — cross-instance
  correct, no new infra beyond the `pg` client.
- **Single global channel `order_status` + in-app filter** (not per-order channels) —
  one `LISTEN` connection, no channel-name churn / identifier-injection surface.
- **Timeout = webhook-driven, no timer/clock in Payment** — `%100==99` records
  `PROCESSING` and waits for the inbound webhook; the demo/tests trigger it. (The
  roadmap's "clock-injectable gateway" note is moot — no time-based branch remains.)
- **TTL ≫ saga p99** for the confirm-after-release race; auto-cancel → Phase 7.
- **Refund = Payment-side emit + record only**, idempotent, no consumer.
- **Webhook + refund idempotency = compare-and-set `updateMany`**, not read-then-write —
  they are concurrent HTTP endpoints (no partition serialization); CAS is the only guard
  that survives simultaneous requests. (The reachable form of the concern the oracle
  deferred for Order's `setStatus` in the 3b review.)
- **SSE listener failure = fail-fast liveness-restart** (log + exit non-zero → container
  restart); in-process reconnect-without-restart deferred to the Phase-5 resilience pass.
- **Webhook/refund unauthenticated** — Phase 6 gateway owns auth; documented.

## Known limitations (intentional, this slice)

1. No auth on SSE/webhook/refund — world-readable stream by `orderId`; anyone can POST
   the webhook or refund. Phase 6.
2. No `Last-Event-ID` replay — a client reconnecting only re-reads current status; it
   cannot replay intermediate transitions it missed while disconnected (acceptable — the
   status is the projection).
3. In-process registry — SSE subscribers are per-process; a client's stream lives on one
   Order instance. `NOTIFY` reaches every instance, so any instance can serve any order —
   but a dropped connection must reconnect (possibly to another instance) and re-reads.
4. TTL race only mitigated by config, not compensated (Phase 7).
5. No `payment.refunded` consumer — the event is emitted for future use / observability
   only.
6. A `PROCESSING` order whose webhook never arrives streams open indefinitely
   (heartbeats only) and never reaches a terminal state — the client disconnects when it
   gives up. No server-side timeout this slice (Phase-7 order-side auto-cancel).
7. SSE listener recovers by process restart, not in-process reconnect (Phase-5
   resilience-pass upgrade) — a PG restart briefly drops all streams until the container
   restarts and clients auto-reconnect.

## Testing (TDD)

- **SSE fan-out registry (unit):** subscribe/notify/unsubscribe, terminal-close,
  heartbeat, multi-subscriber, with a fake `res`. No DB.
- **SSE endpoint (int):** real Postgres; open `GET /orders/:id/stream`, drive a
  transition (call `handleEvent` with an injected `payment.events` envelope), assert the
  received frames (initial + transition + terminal close). 404 for unknown order.
  **Mechanism note (do not discover this cold):** `supertest` buffers the response and
  does not cleanly consume `text/event-stream` — use a raw Node `http` request against
  `server.listen(0)` and parse chunked `data:` frames with a deadline, closing the
  socket on the terminal frame. The **fan-out unit test carries the logic coverage**;
  this int test proves the NOTIFY→frame wire end-to-end (mirrors the deliberate
  awkwardness of 3b's kafka-DLQ int test).
- **Webhook (unit + int):** `finalizePayment` guards (`PROCESSING`-only, idempotent);
  int `POST /webhooks/payment` resolves a seeded `PROCESSING` payment → asserts status +
  one `payment.succeeded`/`failed` outbox row; already-finalized → 200 no new row.
- **Refund (unit + int):** guards (`SUCCEEDED`-only → 409 otherwise; idempotent 200); int
  emits exactly one `payment.refunded` outbox row.
- **e2e (per-leg, injected neighbour events — two services can't share a Vitest process):**
  Order SSE leg (stream a full `PENDING→AWAITING_PAYMENT→CONFIRMED` while injecting
  `payment.events`); Payment webhook leg (`ChargePayment` amount `%100==99` →
  `PROCESSING`, no event → webhook → `payment.succeeded`); Payment refund leg.
- **Manual full-loop runbook** (`docs/runbooks/phase-3c-*.md`): `docker compose --profile
  app up`; place a `%100==99` order; `curl -N localhost:3002/orders/<id>/stream`; observe
  `AWAITING_PAYMENT`; `curl -X POST localhost:3003/webhooks/payment` → stream shows
  `CONFIRMED`; `curl -X POST localhost:3003/admin/payments/<id>/refund` → `payment.refunded`.
- **Regression gate:** `services/order services/payment services/inventory packages/shared`
  green (the sweeper stale-data caveat from 3b noted).

## Definition of Done

- `GET /orders/:id/stream` streams every transition of a live order and closes on the
  terminal state; two concurrent clients on the same order both receive frames.
- A `%100==99` order sits at `AWAITING_PAYMENT` (Payment `PROCESSING`, no event) until
  the webhook, then reaches `CONFIRMED` (or `CANCELLED` for `outcome:"FAILED"`); the
  reservation is `CONSUMED`.
- `POST /admin/payments/:orderId/refund` on a `SUCCEEDED` payment emits exactly one
  `payment.refunded` and is idempotent; non-`SUCCEEDED` → 409.
- Unit + int + per-leg e2e green; typecheck + format clean; ids-only logging.

## Open questions

1. **Listener location** — Order-local `sse-listener.ts` (spec default) vs a shared
   `@ecom/shared` `createPgListener` helper. Deferred to Order-local; revisit if Phase 8
   or another service needs `LISTEN`.
2. **Terminal-close vs keep-open** — spec closes the stream on `CONFIRMED`/`CANCELLED`.
   If Phase 8's tracker wants to keep the connection open past a terminal state (e.g. to
   later show `REFUNDED`), revisit — but `REFUNDED` has no Order consumer this slice, so
   nothing would stream anyway.
3. **`pg` vs reusing Prisma's engine** — confirmed `pg` is required (Prisma can't hold a
   `LISTEN`); flagged as the one new runtime dependency for approval.
