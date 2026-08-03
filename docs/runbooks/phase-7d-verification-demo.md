# Phase 7d — verification demo

How to run the load test, the chaos scenarios and the invariant checker, and how to read
what they say. Everything here was executed on 2026-07-30 against the full stack; the
numbers quoted are from that run.

## 0. Bring the stack up

```bash
docker compose -f docker-compose.example.yml --profile app up -d
```

`identity` needs `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY`, `payment` needs
`PAYMENT_WEBHOOK_SECRET`, all from the gitignored compose env file at the repo root.
**`identity` crash-loops without a key and `gateway` depends on it being healthy, so both
stay down and every scenario fails at the first request.** If a port is already taken, add a
throwaway `-f` override rather than editing the committed file — and note that Compose
*merges* sequence keys, so a `ports:` list needs `ports: !override` to replace rather than
append to the base binding.

Everything below assumes these, adjusted to wherever the stack actually is:

```bash
export PGBASE=postgresql://ecom:ecom@localhost:5432
export PRODUCT_ID=<a product id with stock — see §2>
export COMPOSE="docker compose -p ecom-platform -f docker-compose.example.yml"
```

`COMPOSE` **must carry `-p`**. Without it Compose derives the project name from the
directory, so `stop kafka` matches nothing and a chaos scenario reports success having
broken absolutely nothing.

## 1. The invariant checker

Six invariants over seven databases and two brokers. Zero output rows means it holds.

```bash
PGBASE=$PGBASE npx tsx infra/scripts/assert-invariants.ts clean
```

| | Invariant | What a violation means |
|---|---|---|
| INV1 | No `Order` left `PENDING` or `AWAITING_PAYMENT` after drain | A saga stalled. Check consumer group lag first — see §5. |
| INV2 | No order both `CANCELLED` and carrying a `SUCCEEDED` payment | Money taken for an order the customer was told was cancelled. The sharpest double-effects check. |
| INV3 | For one `orderId`, no `Reservation` split across `CONSUMED` and `RELEASED` | The oversell bug 3b closed. |
| INV4 | No `Outbox` row with `sentAt IS NULL` after the relay drained | An event the world never saw. |
| INV5 | DLQ depth zero — **both** Kafka topics and Rabbit queues | A message parked instead of being handled. Emitted as one violation per transport. |
| INV6 | Every `CONFIRMED` order has a `SUCCEEDED` payment | The cross-service consistency the saga exists to provide. |

`DRAIN_TIMEOUT` is not an invariant but is reported like one: the checker polls until no
order is in flight and no outbox row is unsent, and if the deadline passes it reports **what
was still in flight** rather than passing quietly. `DRAIN_SECONDS` (default 60) tunes it.

**Integration tests no longer pollute this.** Sixteen test files used to leave rows that
tripped INV1, INV4 and INV6 — a full regression left 56 unsent outbox rows across five
databases. Each now tags what it seeds and deletes it in `afterAll`, so the checker is
trustworthy immediately after `pnpm vitest run`, and the acceptance sequence needs no
special ordering.

## 2. k6 load

Full detail in [`k6/README.md`](../../k6/README.md), including the cross-validation and why
each iteration presents a distinct `X-Forwarded-For`. Short version:

```bash
PID=$(curl -s "http://localhost:8000/products?limit=1" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
docker exec ecom-platform-postgres-1 psql -U ecom -d inventory -c \
  "INSERT INTO \"Inventory\" (\"productId\", available, \"updatedAt\")
   VALUES ('$PID', 100000, now())
   ON CONFLICT (\"productId\") DO UPDATE SET available=100000, \"updatedAt\"=now();"
PRODUCT_ID=$PID k6 run k6/checkout.js
```

Reading it: all three thresholds must print `✓` **and the process must exit 0**. The
2026-07-30 baseline was 229 iterations / 2018 requests / 0 failures, `http_req_duration`
p95 204 ms, `saga_duration` p99 1.78 s.

**Seeding stock is not optional.** Without it every order is cancelled for insufficient
inventory and all three thresholds still go green — a pass on a run that tested nothing.
`setup()` refuses to start without `PRODUCT_ID` and probes it through the gateway for
exactly this reason.

**On comparing k6's saga p99 to Prometheus's:** don't, at p99. `SAGA_BUCKETS` jumps 1 → 2.5,
wider than the whole observed spread, so `histogram_quantile` interpolates inside one bucket
and reports 2.43 s for a true value of about 1.78 s. Compare at p50, where the buckets
resolve — 1.03 s client-side against 0.8165 s server-side on the baseline run, a 214 ms gap,
inside the 250 ms poll interval and in the expected direction. Until a bucket boundary is
added near 1.5–2 s, **treat the server-side saga p99 as a conservative overestimate in the
1–2.5 s range**, not a precise number.

## 3. Chaos scenarios

```bash
bash infra/scripts/chaos.sh kafka       # C1 — broker loss
bash infra/scripts/chaos.sh inventory   # C2 — mid-saga service loss
bash infra/scripts/chaos.sh poison      # C3 — unparseable message
bash infra/scripts/chaos.sh order       # C4 — proxied service loss, validates the alerts
```

Each drives traffic, breaks something, restores it, waits for drain and asserts the checker
agrees. **A scenario passes only on exit 0 — check it directly, not through a pipe into
`grep` or `tail`, which hands you the exit code of `tail` instead.** That is how an aborted
C4 was twice mistaken for a passing one.

| Scenario | Pass looks like | Notes |
|---|---|---|
| `kafka` | Every order returns **201 during the outage**, checker clean afterwards | `POST /orders` is a local Postgres transaction that defers publishing to the outbox, so the customer never sees the broker being down. This is the roadmap's headline Done-when. |
| `inventory` | Orders pile at `PENDING`, then drain; checker clean | With `RESERVATION_TTL_MS` at its 900 s default a 15 s outage exercises the **delay** regime only. To reach **compensation**, restart inventory with a small TTL (e.g. `RESERVATION_TTL_MS=20000`) and use an outage longer than that, so the sweeper expires the reservations and the release path runs. |
| `poison` | `poison parked (2), partition kept moving`, then drained and clean | **Two, not one:** `order.events` has two consumer groups (`inventory-consumers`, `notification-dispatcher`) and each parks its own copy. The real assertion is that a valid order placed *after* the poison still reaches a terminal state — that is what separates "parked" from "stalled partition". It refuses to start on an already-dirty DLQ, because messages parked before the run are a finding, not noise. |
| `order` | `CheckoutErrorBudgetFastBurn fired during the outage`, checker clean after recovery | The only scenario that moves a gateway error counter — see §4. |

## 4. The alerts, and which outage each one catches

Rules live in `infra/prometheus/rules/slo.yml`, scoped to `service="gateway"` with `/readyz`
excluded. That scoping matters: unscoped, the denominator is dominated by other services'
health probes — at idle the stack serves 1.695 req/s of which the gateway is 0.095 — which
always succeed and so quietly desensitise a *checkout* error budget.

Observed under C4 (stopping `order`, 90 s, with traffic throughout):

| Alert | Result | Why |
|---|---|---|
| `CheckoutErrorBudgetFastBurn` | **fired** (`severity: page`) | 1m and 15m legs both crossed 14.4× the 1% budget. |
| `CheckoutErrorBudgetSlowBurn` | **pending only** | Needs `for: 2m` on top of a 1h leg that a 90 s outage barely moves. Correct, not a gap. |
| `CheckoutLatencySLOBreach` | **did not fire** | **An open circuit answers in single-digit milliseconds — a 503 is fast.** A hard outage destroys availability without touching latency. |

That last row is the one worth internalising: **latency alerts do not catch hard outages.**
Availability and latency need separate alerts because they fail in different directions.

Two properties of any alert-validation run are load-bearing, and each fails in a way that
looks exactly like a broken rule:

- **The outage must outlast the long window.** A 15 s blip cannot move a 15m rate.
- **Traffic must keep flowing throughout.** An error *rate* needs a denominator; a driver
  that stops when requests start failing flattens the rate instead of climbing it.

And a third, learned the hard way: **do not sample the alert once at a fixed time.** The
firing moment is not predictable, because the 15m leg's denominator still holds every healthy
request from the preceding quarter hour, so the crossing time depends on prior traffic
volume, and `for: 30s` adds more. `chaos.sh` polls to a deadline (`ALERT_WAIT_SECONDS`,
default 180). A single read missed a real firing by 33 seconds.

## 5. When a saga looks stuck

INV1 firing does not by itself mean an event was lost. Check the consumer groups first:

```bash
docker exec ecom-platform-kafka-1 /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 --describe --group order-consumers
```

**`LAG` with no `CONSUMER-ID` means the service is not attached** — the event is waiting, not
lost, and it will be consumed when the consumer rejoins. A stalled saga during 7d's own C4
run looked precisely like a lost event until this showed lag 1 with no member: the service
had never been restarted because the scenario aborted early. Once it came back the event was
consumed and the order reached `CONFIRMED`.

To distinguish genuinely lost from merely waiting: an event that was *consumed but not
applied* leaves a `ProcessedEvent` row in the consuming service's database with no
corresponding state change. No row and non-zero lag is a delivery that has not happened yet.

Other useful reads:

```bash
npx tsx infra/scripts/drain-dlq.ts            # truncate the Kafka DLQ topics after inspecting them
bash infra/scripts/reset-dev-topics.sh        # a long-lived local broker accumulates durable-topic
                                              # history until e2e replay breaches the poll budgets
```

## 6. What these numbers are and are not

Every measurement here comes from one laptop running eight services, two brokers, Postgres,
Redis and the observability stack in containers, with the load generator on the same machine.
They are a **regression signal against another run on the same machine**, not a benchmark.
Do not compare them to production, to a cloud instance, or to anyone else's numbers.
