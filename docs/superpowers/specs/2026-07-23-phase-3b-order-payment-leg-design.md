# Phase 3b · Order payment-leg (saga completion) — Design (child spec)

> Child spec of the umbrella [`2026-07-18-microservices-streaming-rebuild-design.md`](./2026-07-18-microservices-streaming-rebuild-design.md)
> and the [Phases 3–8 roadmap](./2026-07-23-phases-3-8-roadmap.md). Second slice of
> **Phase 3 (Payment)**. Builds on [3a](./2026-07-23-phase-3a-payment-standalone-design.md)
> (Payment service standalone) and [2b](./2026-07-22-phase-2-order-foundation-design.md)
> (Order reserve-leg). **This slice closes the choreographed saga loop:** Order drives
> the payment leg and reaches `CONFIRMED`; Inventory consumes the confirmation.

## Purpose

After 3a, Payment charges a `ChargePayment` command in isolation; after 2b, Order
reaches `AWAITING_PAYMENT` and stops. Nothing connects them. This slice wires the leg:
Order **emits `ChargePayment`** (atomically, in the same transaction as its
`AWAITING_PAYMENT` write) to RabbitMQ, **consumes `payment.events`** and transitions to
`CONFIRMED`/`CANCELLED`, and **Inventory consumes `order.confirmed`** to mark its
reservation `CONSUMED` (immune to the expiry sweeper — closing the confirm-after-release
oversell gap). It also generalizes the shared outbox relay to drive **two transports**
(the first real dual-write from one outbox) and folds in two shared-resilience fixes.

The full choreography now runs end-to-end: place → reserve → **charge** → confirm, plus
the compensation path (payment declined → cancel → stock released).

## Scope

**In:**
- **Shared outbox relay — dual-transport** (`packages/shared/src/outbox.ts`): an optional
  `commands` channel routes selected outbox rows to RabbitMQ while the rest go to Kafka.
  Backward-compatible; Inventory/Payment/hello call sites unchanged.
- **Shared `sendCommand` reliability** (`packages/shared/src/rabbitmq.ts`): a
  publisher-confirm channel so the relay never marks a command sent that the broker never
  acked.
- **Shared Kafka consumer parse fix** (`packages/shared/src/kafka.ts`): parse the envelope
  **inside** the handler try so a malformed envelope dead-letters instead of stalling the partition.
- **Order state machine widen** — `CONFIRMED` reachable; `ChargePayment` emitted on the
  reserve transition; `payment.events` consumed.
- **Inventory `CONSUMED`** — new reservation status + an `order.confirmed` consumer.
- **Contracts** — `ORDER_CONFIRMED`.
- Full-saga e2e (happy + payment-fail compensation).

**Out (deferred — YAGNI):**
- **Confirm-after-release race handling** — with 3a's synchronous gateway the saga
  completes in milliseconds while `RESERVATION_TTL_MS` is 15 min, so the sweeper cannot
  fire mid-saga; the `CONSUMED` transition guards on `status = ACTIVE` and logs+no-ops a
  non-ACTIVE reservation. Real handling (async payment can be slow) lands in **3c**
  (timeout/webhook) and Phase 7 (chaos).
- **SSE** `GET /orders/:id/stream` — 3c.
- **Refund / `PAYMENT_REFUNDED`** — 3c.
- Storing `paymentId` on the Order (the transition keys on event *type*, not payload id).
- Transport-column outbox (Debezium-style) — see Design decisions; only warranted if the
  relay ever moves out-of-process.

## Command-relay design (the load-bearing piece)

**Decision (oracle review, high confidence): generalize the shared relay with an optional
`commands` channel — no migration, no adapter, backward-compatible.** Routing is a pure
function of `row.type`, which the `Outbox` table already stores.

New shared types (`packages/shared/src/outbox.ts`):

```ts
// createRabbit()'s return object structurally satisfies this — no adapter class.
export interface CommandSenderPort {
  sendCommand(queue: string, envelope: EventEnvelope): Promise<void>;
}

// A sender + a per-row router: queueFor returns the Rabbit queue for a command
// row, or null = "not a command → publish to Kafka via topicFor" (default path).
export interface CommandChannel {
  sender: CommandSenderPort;
  queueFor: (row: OutboxRow) => string | null;
}

// UNCHANGED positional signature; `commands` is a NEW optional opts key.
startOutboxRelay(port, producer, topicFor, opts: {
  intervalMs?: number; limit?: number; commands?: CommandChannel;
});
```

**Lane-partitioned drain** (`drainOutbox`): split the fetched batch into a Kafka lane
(`queueFor` → null) and a Rabbit lane (`queueFor` → queue), drain both under
`Promise.allSettled`. A Rabbit outage cannot wedge the Kafka rows and vice-versa (today's
single sequential loop head-of-line-blocks the whole table). **Within a lane, abort on the
first failure** (skip-and-continue would reorder same-aggregate Kafka events); the unsent
rows keep `sentAt = null` and retry next tick. Cross-transport order (a `payment.charge`
command vs an `order.*` event) is not required — different consumers, both idempotent.

**Relay tick gains a catch.** Today the tick is `try/finally` with **no catch**
(`outbox.ts`), so any drain throw is an unhandled rejection (process-fatal on modern Node
once KafkaJS exhausts its retries). Rabbit adds a whole new failure surface, so
`Promise.allSettled` + a logged rejection per lane makes the tick total. This is a
pre-existing hazard fixed here because 3b is what first exercises it.

**Order's routeFor:** `queueFor: (row) => row.type === CHARGE_PAYMENT ? "payment.charge" : null`.
The `ChargePayment` row is written to Order's existing `Outbox` (aggregateType `order`) in
the **same `prisma.$transaction`** as the `AWAITING_PAYMENT` status change — atomicity is
preserved by construction; the relay only changes the read/publish side.

**At-least-once intact:** a crash or `markSent` failure after send re-delivers next tick
with the same `eventId` (the relay reuses `row.id`); Payment dedups via `markProcessed` +
unique `Payment.orderId`.

## `sendCommand` reliability — confirm channel

`sendCommand` today is fire-and-forget (`ch.sendToQueue`, no publisher confirms), so the
relay's `send → markSent` can mark a `ChargePayment` sent that never reached the broker (a
crash before the socket flushes) → **the command is lost and the order strands at
`AWAITING_PAYMENT` forever**. For the money leg that is unacceptable — the outbox exists
precisely to not lose it.

Fix: `createRabbit()` uses `conn.createConfirmChannel()`; `sendCommand` awaits the broker
ack (`ch.sendToQueue(..., cb)` promisified, or `waitForConfirms()`) before resolving. Only
then does the relay call `markSent`. `assertWorkQueue`/`consumeCommands`/`consumeDlqOnce`
are unaffected. Payment's existing consume path and its DLQ tests keep passing (delivery
semantics on the consume side are unchanged).

## Order state machine (`services/order/src/transition.ts`)

The 2b narrow return type is the designed checkpoint — widening it here is the intended,
compile-guarded change.

Transition table (adds the payment rows):

| Current | Event | Next | Emits (same tx) |
|---|---|---|---|
| `PENDING` | `INVENTORY_RESERVED` | `AWAITING_PAYMENT` | **`ChargePayment {orderId, amount}`** → payment.charge |
| `PENDING` | `INVENTORY_RESERVATION_FAILED` | `CANCELLED` | `OrderCancelled {orderId}` |
| `AWAITING_PAYMENT` | `PAYMENT_SUCCEEDED` | `CONFIRMED` | `OrderConfirmed {orderId}` |
| `AWAITING_PAYMENT` | `PAYMENT_FAILED` | `CANCELLED` | `OrderCancelled {orderId}` |
| any other (status, event) | — | `null` (no-op guard) | — |

- `nextStatus` return type widens to `"AWAITING_PAYMENT" | "CANCELLED" | "CONFIRMED" | null`;
  `ApplyOutcome` gains `"CONFIRMED"`.
- **`ChargePayment` needs the amount** → widen the port's `loadOrderStatus(orderId)` to
  `loadOrder(orderId): { status, totalPrice } | null`. The emit uses `Order.totalPrice`
  (the snapshot set at `placeOrder`, 2a). Payload is exactly the 3a contract
  `{ orderId, amount: totalPrice }`.
- The pure core generalizes from `applyInventoryResult` to `applyResult(tx, { eventId,
  type, orderId })` — the load-before-ledger ordering and belt-and-suspenders idempotency
  (`ProcessedEvent` + status guard) are unchanged; it now covers four event types.

## Order wiring (`services/order/src/main.ts`)

- The consumer subscribes to **both** topics: `consumer.run(["inventory.events",
  "payment.events"], handleEvent)`.
- Add RabbitMQ: `const rabbit = await createRabbit(); await
  rabbit.assertWorkQueue("payment.charge")` (producer-side assert is idempotent — Order may
  boot before Payment). Pass the command channel to the relay:
  `startOutboxRelay(outboxPort, producer, (t) => \`${t}.events\`, { intervalMs: 500,
  commands: { sender: rabbit, queueFor: (r) => r.type === CHARGE_PAYMENT ? "payment.charge" : null } })`.
- **Shutdown order:** the relay must stop **before** its Rabbit send channel closes.
  Effective teardown: `server.close → consumer.disconnect → relay.stop → rabbit.close →
  producer.disconnect → prisma.$disconnect`.
- Config gains `RABBITMQ_URL` (default `amqp://ecom:ecom@localhost:5672`).

## Inventory `CONSUMED` (`services/inventory`)

- `Reservation.status` gains `CONSUMED` (comment `ACTIVE | RELEASED | CONSUMED`). Additive
  migration (no enum type change — `status` is a `String`).
- The `order.events` consumer (`handleOrderEvent`) adds an `ORDER_CONFIRMED` branch →
  `reservations WHERE orderId AND status = "ACTIVE"` → set `CONSUMED`. Idempotent
  (`updateMany` on ACTIVE; a redelivery finds none ACTIVE → no-op) and deduped via the
  existing `ProcessedEvent` ledger.
- **Guard:** if no ACTIVE reservation exists at confirm time (already swept/released — the
  deferred race), log a warning and no-op. Unreachable in 3b's synchronous flow.
- The expiry **sweeper already releases only `ACTIVE`** rows, so `CONSUMED` reservations
  are immune — the confirm-after-release oversell gap is closed for the reachable cases.
- `RESERVATION_TTL_MS` stays `900_000` (15 min ≫ the sub-second synchronous saga).

## Contracts (`packages/contracts/src/events/order.ts`)

Add `ORDER_CONFIRMED = "order.confirmed"` with `OrderConfirmedPayloadSchema { orderId }`
(mirrors `OrderCancelledPayloadSchema`). `ChargePayment`/`PaymentSucceeded`/`PaymentFailed`
already exist (3a). No other contract change; `order.confirmed` rides `order.events`.

## Configuration & inherited Definition of Done

- **Order** config gains `RABBITMQ_URL`. **`/readyz` stays Postgres-only** (unchanged from
  2b) — deliberately NOT probing RabbitMQ, unlike Payment. Payment's rabbit is
  readiness-critical *command intake*; Order only *relays to* rabbit through its **outbox**,
  which durably buffers `ChargePayment` across a rabbit outage (the lane-isolated relay
  retries), so Order stays ready and keeps accepting/placing/reserving orders during a
  rabbit blip. Probing rabbit here would flip Order unready for a dependency the outbox is
  designed to absorb.
- **Inventory** unchanged config; one additive migration.
- Graceful shutdown updated per the wiring above. CI: the `integration` job already runs
  `services/order` + `services/inventory` (with RabbitMQ in the stack); no new per-service
  step — but the Order step's env gains `RABBITMQ_URL`.
- Everything else inherited from Phase 0 `shared`.

## Design decisions (resolved)

- **Command-relay = generalize the relay (Option B), not a transport column (A) or a second
  outbox (C) or a type-prefix convention (D).** A/C add N per-service migrations for a
  distinction `row.type` already encodes; D would misroute Payment's own `payment.*` Kafka
  events. B is config-in-code, zero migration, backward-compatible, and Phase-5 reuses it
  verbatim (`queueFor: (r) => r.type === SEND_EMAIL ? "notifications" : null`). *Runner-up A
  becomes right only if the relay ever moves out-of-process (centralized CDC), at which
  point routing must be data.* (Oracle review, high confidence.)
- **Confirm channel: included** (not deferred) — losing a `ChargePayment` strands an order
  and there is no recovery path in 3b.
- **Confirm-after-release race: deferred to 3c** with a defensive ACTIVE-guard (user
  decision; unreachable under synchronous payment).
- **One task-decomposed slice** (branch `feat/order-payment-leg`), not split — the payment
  leg only means anything as a closed loop (user decision).

## Known limitations (intentional, this slice)

1. **Confirm-after-release deferred** (see Scope/Design decisions).
2. **No SSE / refund** (3c).
3. **`paymentId` not persisted on the Order** — the transition keys on event type; the
   payment↔order link lives in Payment's `Payment.orderId`. A read-model join is future work.
4. **`sendCommand` confirm is per-message synchronous** — simplest correct option;
   batching confirms is a possible later optimization, not needed at this throughput.

## Testing (TDD)

- **Unit** — `nextStatus`/`applyResult`: the two new payment transitions + the ChargePayment
  emit on `AWAITING_PAYMENT` (with `amount = totalPrice`); every guard still returns `null`.
  Shared `drainOutbox`: a mixed batch routes command rows to the Rabbit sender and event
  rows to the Kafka producer; a throwing Rabbit lane does not stop the Kafka lane
  (allSettled); the tick no longer throws.
- **Integration** (real PG + Rabbit + Kafka):
  - Shared: `sendCommand` waits for a broker confirm (a message to a queue is confirmed).
    Kafka consumer: a malformed envelope dead-letters (does not stall) — proves the parse fix.
  - Order: `PAYMENT_SUCCEEDED` on `AWAITING_PAYMENT` → `CONFIRMED` + one `ORDER_CONFIRMED`
    outbox; `PAYMENT_FAILED` → `CANCELLED` + `ORDER_CANCELLED`; `INVENTORY_RESERVED` →
    `AWAITING_PAYMENT` + one `ChargePayment` outbox row (`amount = totalPrice`); dedup +
    out-of-order guards hold across all four types.
  - Inventory: `ORDER_CONFIRMED` → reservation `CONSUMED`; a redelivery is a no-op; a
    non-ACTIVE reservation logs + no-ops.
- **Full-saga e2e** (all real brokers + services driven in-process where possible, else
  contract-event injection per the 2b/3a precedent): seed price+stock+cart → `POST /orders`
  → poll `GET /orders/:id` to `CONFIRMED` and assert the reservation is `CONSUMED`; and the
  **compensation path**: force a decline (order total ending `…01`) → order reaches
  `CANCELLED` and the reservation is `RELEASED`.

## Definition of Done

- Order emits `ChargePayment` atomically and reaches `CONFIRMED` on `PaymentSucceeded` /
  `CANCELLED` on `PaymentFailed`; Inventory marks the reservation `CONSUMED` on
  `OrderConfirmed`.
- The shared relay drives both transports with lane isolation + a total tick; `sendCommand`
  is confirm-backed; the Kafka consumer parse fix is in.
- Full saga green both ways (confirm + compensation); `CONSUMED` reservation survives the sweeper.
- Backward compatibility: inventory/payment/hello relay call sites + tests unchanged.
- Inherited DoD (config incl. Order's `RABBITMQ_URL`, health — Order `/readyz` stays
  Postgres-only, outbox absorbs rabbit outages — graceful shutdown, CI) satisfied.
- Unit + integration + full-saga e2e green.

## Open questions

None blocking. Resolved: command-relay = generalized relay with a `commands` channel
(oracle, high confidence); confirm channel included; confirm-after-release deferred to 3c
with an ACTIVE-guard; single task-decomposed slice.
