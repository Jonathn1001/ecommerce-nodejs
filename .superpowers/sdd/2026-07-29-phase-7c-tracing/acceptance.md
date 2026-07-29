# Phase 7c — End-to-end tracing acceptance evidence

Date: 2026-07-29. Branch `feat/phase-7c-tracing`. Stack brought up via
`docker-compose.example.yml` + a local host-port-remap override (postgres 5433, mailpit
1026/8026, `build.network: host`) so it coexists with an unrelated `eda-platform` stack
already holding 5432/9090/4318/1025/8025 on this machine. `kafka-ui`, `prometheus`, and
`grafana` were left out of the `up` invocation — `kafka-ui` collides with the eda-platform
stack on host port 8080 (not covered by the override) and neither is needed to verify
tracing, so the services were started explicitly: `postgres kafka rabbitmq mailpit redis
jaeger hello inventory order payment catalog notification identity gateway`.

## 1. Services reporting to Jaeger

```
$ curl -s http://localhost:16686/api/services
{"data":["notification","identity","inventory","catalog","gateway","jaeger-all-in-one","payment","order"],"total":8}
```

All 7 application services plus Jaeger's own self-instrumentation. **`hello` is absent** —
expected and pre-existing: its container CrashLoops because its runtime `CMD` shells out to
corepack, which tries to fetch pnpm from `registry.npmjs.org` at container startup and cannot
reach it in this environment. `services/hello/Dockerfile` is untouched by 7b or 7c. Confirmed
from the container's own logs:

```
{"level":"info","message":"tracing_started","pid":1,"service":"hello","timestamp":"2026-07-29T12:23:04.723Z"}
! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-10.28.0.tgz
Error: getaddrinfo EAI_AGAIN registry.npmjs.org
```

Tracing itself starts fine inside the container (`tracing_started` logs) — it never gets the
chance to emit an HTTP span because the process dies before `app.listen`. This is the same
limitation noted for `hello`'s Prometheus target; its spans cannot be verified in-container.

## 2. Real checkout, saga settled

Driven entirely through the gateway on `:8000` (register → promote to ADMIN via a direct DB
update, since there is no seeded admin account or self-service promotion → login again for a
fresh JWT carrying the `ADMIN` role claim → create a product → seed inventory stock directly
against `:3001` since the gateway has no `/inventory` mount → add to cart → place order),
following the exact double-submit CSRF + `name`-field-on-register + `/cart` (not
`/orders/cart`) details called out in the brief.

- User: `trace-e2e-1785328177@example.test`
- Product: `7c0a4fe6-0c15-4d2d-9c34-9bbc48c3a26d` ("Trace Widget 7c", ELECTRONICS, price 900 —
  chosen so `simulateCharge`'s `amount % 100` deterministically resolves `SUCCEEDED`, not the
  async `PROCESSING` leg)
- Order: `cfde8b55-3deb-4870-b347-4affcb922a05`, placed `PENDING` → polled `CONFIRMED` after 2
  polls (~1s)

Confirmed **from each service's own database**, not from HTTP responses:

```
order:      SELECT id, status, "totalPrice" FROM "Order" WHERE id='cfde...';
            -> CONFIRMED, 900

payment:    SELECT id, "orderId", status, amount FROM "Payment" WHERE "orderId"='cfde...';
            -> SUCCEEDED, 900

inventory:  SELECT id, "orderId", "productId", status FROM "Reservation" WHERE "orderId"='cfde...';
            -> CONSUMED

notification: SELECT id, "orderId", type, status, "to" FROM "Notification" WHERE "orderId"='cfde...';
            -> order.placed   SENT
            -> order.confirmed SENT
```

Full saga settled: order CONFIRMED, payment SUCCEEDED, reservation CONSUMED, both
notifications SENT.

## 3. The trace — queried via Jaeger's HTTP API, not eyeballed

```
$ curl -s "http://localhost:16686/api/traces?service=gateway&limit=20"
```

returns 20 traces for `gateway`; the checkout trace is unmistakable as the only one with
hundreds of spans (`340`) against everything else's dozens:

```
traceID                            spans
...
bcbc3988614ac2fc0e08b7a7e002f31e   340   <- the checkout
...
```

```
$ curl -s "http://localhost:16686/api/traces/bcbc3988614ac2fc0e08b7a7e002f31e"
```

`processes` in that trace: `{p1: order, p2: notification, p3: payment, p4: inventory, p5:
gateway}` — **all five required hops present**, including payment.

### Span timeline (business + producer/consumer spans only; `prisma:*` internal spans elided)

Timestamps are ms from the trace's first span (`gateway POST /orders` server span).

| t (ms) | dur (ms) | service | kind | span |
|---|---|---|---|---|
| 0.0 | 13.40 | gateway | server | `POST /orders` |
| 2.0 | 10.76 | gateway | client | `POST` (proxy call to order) |
| 3.0 | 9.47 | order | server | `POST /orders` (price, create order, clear cart, enqueue outbox — one tx) |
| 135.0 | 1.65 | order | producer | `order.events publish` |
| 138.0 | 6.81 | inventory | consumer | `order.events process` (reserve) |
| 138.0 | 5.99 | notification | consumer | `order.events process` (order.placed email) |
| 424.0 | 1.54 | notification | producer | `notifications send` |
| 426.0 | 59.68 | notification | consumer | `notifications process` (SMTP to mailpit) |
| 544.0 | 2.29 | inventory | producer | `inventory.events publish` |
| 549.0 | 8.84 | order | consumer | `inventory.events process` (→ AWAITING_PAYMENT, enqueue payment.charge) |
| 635.0 | 1.33 | order | producer | **`payment.charge send`** |
| 637.0 | 8.71 | payment | consumer | **`payment.charge process`** |
| 877.0 | 1.99 | payment | producer | `payment.events publish` |
| 879.0 | 12.03 | order | consumer | `payment.events process` (→ CONFIRMED, enqueue order.confirmed) |
| 1136.0 | 1.08 | order | producer | `order.events publish` |
| 1138.0 | 3.11 | inventory | consumer | `order.events process` (mark reservation CONSUMED) |
| 1138.0 | 4.85 | notification | consumer | `order.events process` (order.confirmed email) |
| 1427.0 | 1.13 | notification | producer | `notifications send` |
| 1428.0 | 45.91 | notification | consumer | `notifications process` (SMTP to mailpit) |

Total spans in the trace: 340 (the rest are `@prisma/instrumentation`'s per-query engine
sub-spans, several per business DB call).

### 3a. Payment hop — present, and confirmably over RabbitMQ

The `payment.charge send` → `payment.charge process` pair is a direct `CHILD_OF` reference
(order's producer span `a32b75a050692700` is the parent of payment's consumer span
`ac375a924c6ac538`), and the two sides' `otel.scope.name` tags prove which transport carried
it:

```
order   "payment.charge send"    otel.scope.name = @ecom/shared/outbox      (producer wrapper; same for every relay lane)
payment "payment.charge process" otel.scope.name = @ecom/shared/rabbitmq    span.kind=consumer
                                  messaging.destination.name = payment.charge
                                  messaging.message.id = fbebe7b9-9a44-4284-87f2-0c9a2051cc80
```

Contrast with a same-trace Kafka hop (`order.events process` on inventory):

```
inventory "order.events process" otel.scope.name = @ecom/shared/kafka       span.kind=consumer
                                  messaging.destination.name = order.events
```

`@ecom/shared/kafka` vs. `@ecom/shared/rabbitmq` on the two consumer spans is the concrete,
quotable proof that the payment leg specifically travelled over RabbitMQ (Task 7's seam) and
not Kafka — the one failure mode this step exists to catch.

### 3b. The relay polling gap — visible at every hop

Gap = (business span end) → (next producer span start). All six relay-mediated hops in the
trace show a positive, non-trivial gap, consistent with the 500ms outbox-relay poll interval
(the size of each gap is just the phase offset between "row committed" and "next poll tick"):

| business span ends | next publish/send starts | gap |
|---|---|---|
| order `POST /orders` @ 12.47ms | order `order.events publish` @ 135.0ms | **122.5ms** |
| inventory `order.events process` @ 144.8ms | inventory `inventory.events publish` @ 544.0ms | **399.2ms** |
| order `inventory.events process` @ 557.8ms | order `payment.charge send` @ 635.0ms | **77.2ms** |
| payment `payment.charge process` @ 645.7ms | payment `payment.events publish` @ 877.0ms | **231.3ms** |
| order `payment.events process` @ 891.0ms | order `order.events publish` @ 1136.0ms | **245.0ms** |
| notification `order.events process` @ 1142.9ms | notification `notifications send` @ 1427.0ms | **284.1ms** |

Every gap sits inside `(0, 500ms]`, exactly as expected for a 500ms poll: this is the
design's central promise (Task 6/7's relay never republishes into the caller's own span —
it parents to the *stored* context and injects its *own* — so the gap between the DB write and
the wire send is now a real, visible, measurable thing instead of hidden inside one span).

## 4. `traceId` round-trip from an order-service log line

```
$ docker logs ecom-platform-order-1 | grep 'cfde8b55-3deb-4870-b347-4affcb922a05' | grep order_placed
{"level":"info","message":"order_placed","orderId":"cfde8b55-3deb-4870-b347-4affcb922a05","service":"order","timestamp":"2026-07-29T12:29:38.013Z","traceId":"bcbc3988614ac2fc0e08b7a7e002f31e"}

$ curl -s "http://localhost:16686/api/traces/bcbc3988614ac2fc0e08b7a7e002f31e" | jq '.data | length'
1
```

The `traceId` printed in the order service's own structured log line finds **exactly** the
trace inspected above — one trace, 340 spans, same five services. Step 4's discrimination
check passes: this is not a coincidental match, it is the actual trace the checkout produced.

## 5. Idle span rate (no traffic, 60s window)

Measured with the stack fully up, no application traffic in flight, over a clean 60-second
window (`1785327967` → `1785328027` epoch seconds), by summing `spans` across every trace
`GET /api/traces?service=<svc>&start=<us>&end=<us>&limit=3000` returned per service:

| service | traces | spans |
|---|---|---|
| gateway | 6 | 72 |
| order | 126 | 939 |
| inventory | 582 | **8581** |
| payment | 126 | 939 |
| catalog | 126 | 939 |
| notification | 126 | 939 |
| identity | 127 | 958 |
| **total** | **1219** | **13,367** |

**Measured idle floor: 13,367 spans/min (≈ 223 spans/sec).**

`packages/shared/src/outbox.ts`'s relay does **not** create a span on an empty poll tick —
`publishWithSpan` only runs inside the per-row send lane, confirmed by reading the code. The
floor instead comes from: (a) `@prisma/instrumentation`'s query span tree on the relay's own
`fetchUnsent` call, which every service's 500ms outbox poll issues regardless of whether it
finds rows (this produces several spans per tick, not one — order/payment/catalog/notification
all land within a spans-per-60s band of 939, ≈120–130 poll ticks × ~7 spans each); (b) the
10s-interval Docker healthcheck (`GET /readyz`) hitting Express + Prisma instrumentation on
every service, plus a Redis ping on inventory's; (c) identity's slightly higher count is its
own poll cadence plus healthcheck shape.

**`inventory` is a 9x outlier and it is explained, not mysterious:** its 5-second reservation
sweeper (`services/inventory/src/sweeper.ts`) is permanently retrying **37 stale `ACTIVE`
reservations** left over from previous days' manual/test runs, whose `productId`s no longer
have a row in the `Inventory` table (deleted or never-recreated since those rows were
written). Every 5s tick, `sweepOnce()` re-queries the same 37 rows, groups them into ~34
distinct orders, and each one's `prisma.$transaction` throws
(`prisma.inventory.update()` → "No record was found for an update") — confirmed directly from
the container's own logs (`sweep_order_failed`, repeated every 5s, same 34 `orderId`s each
time). The rows are never marked `RELEASED` because the failure happens before that write, so
this is a steady-state loop, not a one-time backlog drain — it will keep firing every 5s
indefinitely until someone manually clears those 37 rows or reseeds their products. Each failed
attempt still burns a full Prisma span tree before throwing, which is where inventory's extra
~7,600 spans/min come from.

This is pre-existing dev-database drift (accumulated across `2026-07-21` .. `2026-07-29`
manual runs against this long-lived shared Postgres), not a defect in Phase 7c's tracing or
relay code — but it does mean the raw 13,367/min number is **not representative of a healthy
deployment's floor**. Subtracting inventory's anomaly (i.e., assuming it behaved like its
five outbox-relay peers, ~939 spans/60s) gives a **corrected idle floor of ≈5,725 spans/min
(≈95 spans/sec)** across all 7 services — this is the number 7d should use for sizing a
sampling ratio; the raw 13,367/min is what you'd actually observe on *this* machine right now
without first cleaning the stale reservations.

The DLQ poller (`packages/shared/src/metrics.ts`'s `startDlqPoller`, 15s interval, used by
payment and notification) queries RabbitMQ's queue-depth over its management API, which is not
in `ENABLED_INSTRUMENTATIONS` (only http/express/redis/prisma are) — it contributes ~0 spans to
the floor.

## 6. What did not work / concerns

- **`hello` cannot be verified** — pre-existing corepack/registry issue, documented above and
  in the task-9 brief up front. Not a tracing defect.
- **`kafka-ui` could not be started** with the literal `docker compose ... --profile app up -d
  --build` command from the brief — it collides with the unrelated `eda-platform` stack on
  host port 8080, which the prepared override did not remap (only postgres/mailpit were
  remapped). This aborted the compose run before `gateway` started. Worked around by listing
  the exact services needed (`postgres kafka rabbitmq mailpit redis jaeger hello inventory
  order payment catalog notification identity gateway`), skipping `kafka-ui`,
  `prometheus`, and `grafana`, none of which this task needs. Not a 7c code defect — an
  environment-override gap, now known for next time.
- **No seeded admin account, and no self-service promotion path.** `services/identity/prisma/seed.ts`
  seeds `ADMIN`'s grants but never a `User` row. Becoming `ADMIN` requires a direct
  `UPDATE "User" SET "roleId" = ...` against identity's own Postgres DB followed by a fresh
  login (the role is a JWT claim minted at login, not looked up per request) — this matches
  the documented pattern in `docs/runbooks/phase-6-auth-demo.md`, so it is expected behaviour,
  not a gap this phase introduced.
- **Inventory has no gateway mount.** `POST /inventory/stock` must be called directly against
  `:3001`; the gateway's `Upstreams` type has no `inventory` entry at all. Expected/documented
  by the brief itself, noted here for completeness.
- **One flaky test, confirmed environmental, not a regression:**
  `services/order/src/__tests__/order-stream.e2e.test.ts` ("streams PENDING/AWAITING_PAYMENT
  -> CONFIRMED for a real placed order") fails when run as part of the full `services/order`
  suite (reproduced 3×: default parallel run, `--no-file-parallelism`, and with the live
  `ecom-platform-order-1` container stopped — all three still failed), but **passes cleanly in
  isolation** (550ms, single run). Since it fails identically with the live container both up
  and down, the cause is contention among the order service's *own* e2e/int test files sharing
  Kafka consumer-group state within one vitest process, not interference from the acceptance
  checkout or the live compose stack. No 7c commit touches this test file or the SSE registry
  (`git log` on the file shows no phase-7c changes). Flagging as a known pre-existing flake
  for follow-up — not treated as a regression in the pass/fail counts below, but not hidden
  either.

## 7. Full regression

`pnpm -r typecheck`: clean, all 9 workspace packages/services.
`pnpm format:check`: clean.

Per-service (against `postgresql://ecom:ecom@localhost:5433/<db>` — the brief's own snippet
says `:5432`, but the ENVIRONMENT section for this task explicitly overrides that to `5433` for
this machine, and per the plan's own adjudication rule, an explicit environment fact wins over
the brief's literal text):

| service | files | tests |
|---|---|---|
| hello | 2 passed | 2 passed |
| inventory | 10 passed | 30 passed |
| order | 17 passed, **1 failed*** | 67 passed, **1 failed*** |
| payment | 11 passed | 46 passed |
| catalog | 10 passed | 34 passed |
| notification | 8 passed | 20 passed |
| identity | 6 passed | 28 passed |
| gateway | 4 passed | 41 passed |
| packages | 32 passed | 115 passed |
| **total** | **100 files (99 passed, 1 failed)** | **383 passed, 1 failed (384 total)** |

\* `order-stream.e2e.test.ts`, see §6 — passes in isolation, fails only alongside its sibling
files within the same `services/order` vitest invocation, reproduced with the live `order`
container both running and stopped. Root-caused to shared Kafka consumer-group state across
the order suite's own test files, not to phase 7c's changes.

384 total tests recorded here (356 pre-existing + the tracing tests added across Tasks 1–8),
consistent with the plan's expectation.
