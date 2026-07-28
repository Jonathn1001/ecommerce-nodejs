# Phase 7b · Metrics & dashboards — Design (child spec)

> Phase 7 (Hardening, XL) is decomposed into four slices — 7a correctness & hygiene debt
> (done, merged), **7b metrics** (this doc), 7c tracing, 7d verification (k6 + chaos) — plus
> the two umbrella lesson items. Reference:
> `docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md` (Phase 7) and
> `docs/superpowers/specs/2026-07-25-phase-7a-correctness-hygiene-design.md` (slice model).
>
> **Roadmap drift, corrected here:** `roadmap.md:111-122`'s Phase 7 prose still describes the
> pre-7a four-slice model (7a=metrics, 7b=OTel, 7c=k6). The 7a spec's decomposition is
> authoritative. Fixing that prose is a task in this slice (§F).

## Purpose

Make the running system observable in the one dimension it currently has no answer for: what
it is doing right now. Today every service exposes `/healthz` and `/readyz` — binary, and
they say nothing about rate, latency, error ratio, or whether a saga is wedged. A checkout
that takes 30 seconds and a checkout that takes 300 ms look identical from outside.

Phase 7b lands `/metrics` on all eight services, the four domain metrics the roadmap named,
and a single provisioned Grafana dashboard that shows a full checkout end to end.

This is instrumentation, not behaviour: **no business logic changes in this slice.** Every
production code path must behave identically with metrics disabled.

## Scope

**In:**
- `packages/shared/src/metrics.ts` — the shared module (§A).
- HTTP RED + `/metrics` adoption across all 8 services (§B).
- Four domain metrics: Kafka consumer lag, RabbitMQ DLQ depth, saga-step latency, reservation
  outcomes (§C) — plus two cheap extras, `payment_attempts_total` and
  `notifications_sent_total`, that keep the dashboard readable past Order (§C5).
- Prometheus + Grafana in compose, config committed under `infra/` (§D).
- One provisioned checkout dashboard (§E).
- The roadmap prose correction (§F).

**Out — deliberate, with reasons:**
- **SLO burn alerts and Alertmanager.** Deferred to **7d**, where k6 load can actually
  exercise them. Alerting rules that have never fired are not tested, they are decoration.
- **OpenTelemetry traces / Jaeger.** That is 7c. The existing `x-trace-id` correlation
  (`packages/shared/src/trace.ts`) stays exactly as it is.
- **`outbox_pending` gauge.** Considered and rejected for this slice: it needs a
  `countPending()` method on `OutboxPort`, which means editing five per-service adapters plus
  an extra `COUNT` per relay tick. Revisit when there is a reason beyond completeness.
- **kafka-exporter and the `rabbitmq_prometheus` plugin.** Both metrics are derived in-process
  instead (§C1, §C2) — decided, not deferred.
- **A `createServiceRuntime()` bootstrap** bundling trace + health + metrics. Rejected as
  scope creep: adoption is already two lines per `app.ts`, so the bundle buys nothing and
  costs a refactor of all eight.

---

## A. The shared module

`packages/shared/src/metrics.ts`, sibling to `health.ts`, exported from `index.ts`.

```ts
export interface Metrics {
  registry: Registry;                                   // explicit, per service
  httpMiddleware(): RequestHandler;                     // RED
  router(): Router;                                     // GET /metrics
  kafkaHooks: KafkaMetricsHooks;                        // passed into createConsumer
  startDlqPoller(ch: Channel, queues: string[], opts?: { intervalMs?: number }):
    { stop(): void };
}

export function createMetrics(serviceName: string): Metrics;
```

### A1. Explicit registry, not the default one

`createMetrics` constructs its own `prom-client` `Registry` and calls
`registry.setDefaultLabels({ service: serviceName })`, so `service` never appears in an
individual metric's label list. `collectDefaultMetrics({ register: registry })` supplies the
`process_*` / `nodejs_*` families.

The alternative — module-level metric singletons on prom-client's global default registry —
was rejected on a concrete failure mode: vitest runs a service's suites in one process, and a
second import of a module that registers a metric throws
`A metric with the name ... has already been registered`. An explicit registry means each test
constructs its own instance and asserts exact registry contents, with no `registry.clear()`
discipline to forget.

### A2. Ownership split

Shared owns the **generic**: process defaults, HTTP RED, Kafka consumer lag and handler
timing, DLQ depth. Services own their **domain** metrics, registered against the injected
`registry` from their own `services/<name>/src/metrics.ts`. `packages/shared` never learns
what a saga is.

### A3. Adoption shape

Every service's `app.ts` already reads:

```ts
app.use(traceMiddleware());
app.use(createHealthRouter({ ... }));
```

Metrics adoption is the same two-line shape, and nothing else changes in `app.ts`:

```ts
app.use(metrics.httpMiddleware());
app.use(metrics.router());
```

### A4. Wiring — who constructs the `Metrics` object

`main.ts` constructs it, because the Kafka hooks and the DLQ poller are wired there, and passes
it into `createApp`. To keep the "every pre-existing test passes unmodified" promise in §I,
`createApp` **defaults it**:

```ts
export function createApp({ metrics = createMetrics("order"), ... }: Deps = {}) { ... }
```

Every existing `createApp()` call in the test suites keeps working untouched, and a test that
wants to assert on metrics passes its own instance. Order already threads `sseRegistry` through
`createApp` this way, so the shape is not new.

---

## B. HTTP RED and exposure

### B1. The metrics

| Metric | Type | Labels |
|---|---|---|
| `http_requests_total` | Counter | `method, route, status` |
| `http_request_duration_seconds` | Histogram | `method, route, status` |

Buckets: `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5` — chosen to straddle the
roadmap's p95 < 500 ms SLO so the quantile is interpolated from real bucket edges rather than
from a 0.1→1 gap.

Rate, errors and duration are all derivable from these two, so there is no separate error
counter.

### B2. Cardinality is a binding constraint

The `route` label is the **Express route pattern**, never `req.path`. `/orders/abc-123` and
`/orders/def-456` must both label `route="/orders/:id"`, or the series count grows with the
order table.

The pattern is only known once routing has run, so the middleware resolves it on response
finish, from `req.route`. Two traps, both of which must be covered by a test:

1. **`req.route` is undefined for unmatched requests.** 404s label `route="unmatched"`. A
   scanner hitting random URLs must not be able to mint one series per URL.
2. **`req.route.path` is mount-relative.** For a router mounted with `app.use("/orders", r)`,
   a handler registered as `/:id` reports `req.route.path === "/:id"`, not `/orders/:id`. The
   label is `req.baseUrl + req.route.path`. This is the same mount-stripping class as 7a's
   Critical C1 (http-proxy-middleware v3 forwarding the mount-stripped path), so it gets an
   explicit assertion rather than an assumption.

The gateway proxies arbitrary upstream paths and has no Express route pattern for them, so it
labels `route` with the **matched rule's path prefix** (the rules table's own key, e.g.
`/products`) and adds an `upstream` label naming the target service. Never the raw URL.

### B3. Where `/metrics` listens

The seven backend services serve `/metrics` on their existing app port. This matches
`health.ts`, needs no second listener, and is safe because `docker-compose.prod.example.yml`
already `!reset []`s every port except the gateway's — the port is reachable only from the
compose network, which is where Prometheus runs.

**The gateway is the exception.** Its app port 8000 is the one port published in the prod
profile, so `/metrics` there would be internet-facing. The gateway therefore serves `/metrics`
on a **separate `METRICS_PORT` (default 9464)** that the prod profile does not publish.

The rejected alternative was to keep `/metrics` on 8000 and deny it in the gateway's rules
table. 7a's Critical C2 was a case-varied path (`POST /Products`) bypassing that exact table.
Using the component that just demonstrated a bypass as the security boundary for an
unauthenticated metrics endpoint is not a defensible choice. A port that is not published
cannot be case-varied around.

Prometheus targets are per-service `host:port` regardless, so the asymmetry costs nothing in
the scrape config.

---

## C. Domain metrics

### C1. Kafka consumer lag — in-process

`packages/shared/src/kafka.ts`'s `createConsumer` gains an optional `kafkaHooks` argument.
When present it subscribes to kafkajs's `END_BATCH_PROCESS` instrumentation event, whose
payload carries `offsetLag` per topic/partition, and sets:

| Metric | Type | Labels |
|---|---|---|
| `kafka_consumer_lag` | Gauge | `group, topic, partition` |
| `kafka_messages_total` | Counter | `group, topic, result` (`ok` \| `dlq`) |
| `kafka_handler_duration_seconds` | Histogram | `group, topic, type` |

**Known limitation, documented not fixed:** lag is only reported for partitions this consumer
owns, and only when a batch completes. A crashed consumer stops updating the gauge rather than
showing it climb, so the gauge goes *stale*, not *high*. The dashboard therefore pairs lag with
`up{}` for the same service — a stale lag next to `up == 0` is a dead consumer, not a healthy
one. A broker-side `kafka-exporter` is the production answer and is explicitly out of scope
(§Scope).

The instrumentation listener is wrapped so an exception inside it can never kill the consumer.

### C2. RabbitMQ DLQ depth — in-process poll

`startDlqPoller(ch, queues, { intervalMs = 15_000 })` calls `ch.checkQueue(dlq)` on an
interval and sets:

| Metric | Type | Labels |
|---|---|---|
| `rabbitmq_dlq_depth` | Gauge | `queue` |

Two hard requirements:

1. **Its own channel.** `createRabbit`'s working channel is a `ConfirmChannel`, and
   `checkQueue` against a missing queue closes the channel it runs on. Polling on the command
   lane's channel would let a metric take down message sending. The poller opens a dedicated
   non-confirm channel from the same connection.
2. **Never throws.** On a poll error: log, leave the gauge at its last value, keep the
   interval alive. `stop()` clears the interval and joins `gracefulShutdown` alongside
   `pruner.stop()`.

`assertWorkQueue` already asserts `${queue}.dlq`, so the queues exist by the time the poller
starts.

### C3. Saga latency — Order owns the clock

`services/order/src/metrics.ts`:

| Metric | Type | Labels |
|---|---|---|
| `saga_duration_seconds` | Histogram | `outcome` (`confirmed` \| `cancelled`) |
| `saga_step_duration_seconds` | Histogram | `step` (`reserve` \| `payment`) |

Buckets: `0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30` — straddling the roadmap's saga p99 < 5 s SLO.

`services/order/src/transition.ts` is the single seam. Statuses are
`PENDING → AWAITING_PAYMENT → CONFIRMED | CANCELLED`, plus `PENDING → CANCELLED` when
reservation fails, so:

- `step="reserve"` — `PENDING` → `AWAITING_PAYMENT` or `CANCELLED`.
- `step="payment"` — `AWAITING_PAYMENT` → `CONFIRMED` or `CANCELLED`.
- `saga_duration_seconds` — order `createdAt` → the terminal transition.

**Recording happens in the caller, after the transaction commits — never inside
`transition.ts`.** `transition.ts` is a pure module behind a tx port; recording inside it would
count transitions that later rolled back. This is also what keeps the "no behaviour change"
promise literally true: the pure function's signature and return values are untouched.

7a made `setStatus` a compare-and-set that returns `false` on a lost race. A lost CAS is a
`NO_OP` that emits nothing, and it must record nothing either.

### C4. Reservation outcomes — Inventory

`reserveOrder` in `services/inventory/src/reserve.ts` already returns
`"DUPLICATE" | "RESERVED" | "FAILED"`. One counter at its single call site in `consumer.ts`:

| Metric | Type | Labels |
|---|---|---|
| `reservation_outcomes_total` | Counter | `outcome` (`RESERVED` \| `FAILED` \| `DUPLICATE`) |

This covers the roadmap's "reservation conflicts" (`FAILED` = insufficient stock, the only
business failure `reserveOrder` produces) and gives the idempotency-dedup rate from the same
seam at no extra cost.

### C5. Two extras beyond the roadmap's four

Both are a single call at an existing seam, with no port or query changes:

| Service | Metric | Type | Labels |
|---|---|---|---|
| Payment | `payment_attempts_total` | Counter | `outcome` (`succeeded` \| `failed` \| `processing`) |
| Notification | `notifications_sent_total` | Counter | `type, result` |

Without them the dashboard goes dark after Order, which defeats the point of an end-to-end
checkout view. `processing` is the `%100 == 99` webhook-pending path from 3c.

---

## D. Compose and `infra/`

Added to `docker-compose.example.yml`, and mirrored in `docker-compose.prod.example.yml` with
`ports: !reset []` like every other non-gateway service:

```yaml
prometheus:
  image: prom/prometheus:v3.1.0
  ports: ["9090:9090"]
  volumes: ["./infra/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro"]
grafana:
  image: grafana/grafana:11.5.1
  ports: ["3007:3000"]                    # 3000-3006 are taken by the services
  environment:
    GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_PASSWORD:-ecom}
  volumes:
    - ./infra/grafana/provisioning:/etc/grafana/provisioning:ro
    - ./infra/grafana/dashboards:/var/lib/grafana/dashboards:ro
```

Tags are **pinned**, not `:latest`. A committed dashboard JSON is version-coupled to the
Grafana that renders it, and a silently-moving image would break it on someone else's clone.
The two tags above are illustrative — resolve the current stable tag for each at implementation
time and pin *that*. What is binding is that they are pinned, not which version.
Grafana's host port is 3007 because hello…identity already occupy 3000–3006.

Committed under `infra/` — none of it holds a secret, and the admin password comes from the
gitignored `.env` exactly as RabbitMQ's credentials already do:

- `infra/prometheus/prometheus.yml` — 15 s scrape interval, eight static targets on the
  compose network: `hello:3000`, `inventory:3001`, `order:3002`, `payment:3003`,
  `catalog:3004`, `notification:3005`, `identity:3006`, `gateway:9464`.
- `infra/grafana/provisioning/datasources/prometheus.yml` — points at `http://prometheus:9090`.
- `infra/grafana/provisioning/dashboards/dashboards.yml` — file provider reading
  `/var/lib/grafana/dashboards`.
- `infra/grafana/dashboards/checkout.json` — the dashboard (§E).

`docs/infra.md` gains Prometheus and Grafana rows in its endpoint table, plus the
`GRAFANA_PASSWORD` line in `.env.example`.

### D1. CI is untouched

Metrics tests run against the registry object in-process. Nothing scrapes, so CI needs no
Prometheus container, no new job, and no change to the per-service test loop 7a built — the new
tests simply run inside the existing arms.

---

## E. The dashboard

One dashboard, `checkout.json`, provisioned read-only. Panels:

1. **Request rate** — `sum by (service) (rate(http_requests_total[1m]))`
2. **Error ratio** — 5xx share of the same counter, per service
3. **Latency p95** — `histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[5m])))`, with the 500 ms SLO drawn as a threshold
4. **Saga duration p50/p95/p99** — from `saga_duration_seconds`, 5 s threshold
5. **Saga step latency** — `saga_step_duration_seconds` split by `step`
6. **Reservation outcomes** — `rate(reservation_outcomes_total[5m])` by `outcome`
7. **Payment attempts** — `rate(payment_attempts_total[5m])` by `outcome`
8. **Consumer lag** — `kafka_consumer_lag` by group/topic, paired with `up{}` per §C1
9. **DLQ depth** — `rabbitmq_dlq_depth` by queue

Nine panels is the cap for this slice. Hand-authored dashboard JSON is verbose and easy to get
subtly wrong, so the acceptance test is loading it in the real provisioned Grafana and seeing
every panel resolve against a real checkout — not reading the JSON.

---

## F. Roadmap prose correction

`docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md:111-122` still describes Phase 7 as
7a=metrics / 7b=OTel / 7c=k6+chaos. 7a's spec re-cut it as 7a=debt / 7b=metrics / 7c=tracing /
7d=verification, and 7a's own fix wave corrected the absorption-map rows below that prose,
which left the two contradicting each other. Surfaced by the 7a fix-wave re-review and
explicitly deferred to this slice.

Rewrite the prose to the four-slice model. Documentation only — no table row changes, since
the rows are already correct.

---

## G. Decisions

| # | Decision | Why |
|---|---|---|
| 1 | RED + domain metrics + Grafana; **alerts deferred to 7d** | Burn-rate rules can only be validated against k6 load, which is 7d. Untested alerts are decoration. |
| 2 | Consumer lag from **kafkajs `END_BATCH_PROCESS`**, not kafka-exporter | Keeps the mechanism in code we own and unit-testable; no extra container. Staleness blind spot documented and paired with `up{}` on the dashboard. |
| 3 | **Order owns the saga clock** | Matches the SLO wording literally, one service owns the series, and no cross-container clock agreement is assumed. |
| 4 | **Explicit per-service registry** over the global default | Global singletons throw duplicate-registration errors across vitest suites in one process. |
| 5 | **All 8 services**, domain metrics only where a hook exists | `hello` proves the shared module works in the simplest service; the gateway is where edge RED matters most. |
| 6 | DLQ depth from an **in-process `checkQueue` poll** | Consistent with decision 2; no broker plugin, no broker credentials in Prometheus. Mitigated with a dedicated non-confirm channel. |
| 7 | Adoption **mirrors the health/trace two-line pattern**; no runtime bundle | The pattern is already uniform across eight `app.ts` files; bundling would refactor all of them for no gain. |
| 8 | Gateway `/metrics` on a **separate unpublished port** | Port 8000 is internet-facing in the prod profile, and 7a's C2 proved the rules table is bypassable. |
| 9 | `route` label is the **route pattern**, 404s are `"unmatched"` | The cardinality bomb: one series per scanned URL otherwise. |
| 10 | Saga metrics recorded **in the caller after commit** | Recording inside the pure `transition.ts` would count rolled-back transitions and would change a pure module's contract. |
| 11 | Pinned Prometheus/Grafana image tags | A committed dashboard JSON is version-coupled to the Grafana that renders it. |
| 12 | `outbox_pending` **excluded** | Needs `OutboxPort.countPending()` across five adapters plus a per-tick `COUNT`; no demonstrated need yet. |

---

## H. Testing

**Unit — `packages/shared`:**
- `createMetrics("x")` registry contains exactly the expected metric names, and every sample
  carries `service="x"`.
- `httpMiddleware` labels `GET /orders/abc` as `route="/orders/:id"` — asserted against a
  router **mounted at a prefix**, so the test fails if the label is `req.route.path` alone
  (§B2 trap 2) rather than `req.baseUrl + req.route.path`.
- An unmatched request labels `route="unmatched"` — asserted directly, since this is the
  cardinality guard.
- `startDlqPoller` against a fake channel: updates the gauge, survives a `checkQueue` throw
  without stopping, and `stop()` clears the interval.
- The Kafka hook maps an `END_BATCH_PROCESS` payload to the right gauge labels, and a throwing
  listener does not propagate.

**Integration — per service:**
- `GET /metrics` → 200, `text/plain`, body carries `service="<name>"`.
- Gateway: `/metrics` answers on `METRICS_PORT` and **not** on the app port.

**Order:**
- Saga metrics are recorded after a committed transition, and **not** recorded when the tx
  throws or when the compare-and-set loses.

**Regression:** the full suite stays green — 304 tests / 75 files at the 7a merge — plus the
new ones. `pnpm -r typecheck` and `pnpm format:check` clean.

---

## I. Definition of Done

- All 8 services expose `/metrics`; the gateway's is on `METRICS_PORT` and is absent from 8000.
- `docker compose up -d` brings up Prometheus with all 8 targets `up`, and Grafana with the
  dashboard provisioned.
- One Grafana dashboard shows a full checkout's RED + saga metrics, driven by a real order
  through the gateway.
- The four roadmap domain metrics plus the two §C5 extras all move under load.
- No business-logic change: every pre-existing test passes unmodified.
- `roadmap.md` Phase 7 prose matches the four-slice model.
