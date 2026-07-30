# Phase 7d — acceptance evidence

Executed 2026-07-30 against the full stack (`--profile app`, 17 containers) on one laptop.
Postgres on 5432; mailpit remapped to 1026/8026 because another stack holds 1025/8025.
Prometheus on 9090. k6 v0.55.0 as a native binary.

The spec's §I is the acceptance test. The equivalent step found a real defect in each of the
two preceding slices, and it did so again here — see **Findings**.

## Step 1 — clean slate

- `reset-dev-topics.sh` truncated the durable topics (inventory.events to 991, order.events
  to 1943, payment.events to 969, identity.events to 482, catalog.events to 6;
  notification.events absent — nothing consumes it).
- **2 stale ACTIVE reservations cleared**, both already past `expiresAt`, both with no Order
  row and no Inventory row. These are the residue the 7c handover recorded as permanent
  sweeper noise: they come from `sweeper.int.test.ts`'s poison case, which deliberately
  creates an expired ACTIVE reservation whose Inventory row does not exist — unsweepable by
  construction, so the real sweeper retried them every cycle forever. Both predate this
  slice's fixture fix, which now tags and deletes them; no new ones can accumulate.
- Baseline checker: **clean**, all six invariants, before any load.

## Step 2 — k6

`PRODUCT_ID=<seeded> DURATION=1m VUS=5`, exit **0**:

```
203 iterations, 1971 requests, 0 failures
http_req_duration  p(95)=179.10ms  p(99)=247.55ms  max=478.10ms   ✓ <500
saga_duration      p(95)=1.54s     p(99)=1.56s     max=1.81s      ✓ <5000
http_req_failed    0.00%                                          ✓ <0.01
```

Cross-validated against the server-side metric over the same window:

| | k6 (client-side) | Prometheus (server-side) | Gap |
|---|---|---|---|
| saga p50 | 1.28 s | 1.45 s | 170 ms — inside the 250 ms poll interval |
| saga p99 | 1.56 s | 2.479 s | bucket-limited, not comparable — see below |
| gateway p95 latency | 179 ms | 202 ms | 23 ms |

The saga p99 gap is the histogram, not the harness: `SAGA_BUCKETS` jumps 1 → 2.5, wider than
the observed spread, so `histogram_quantile` interpolates inside a single bucket. Reproducing
that interpolation by hand from the raw bucket counts matched Prometheus to 4 decimal places
during Task 4, which is what identified it. **Recommendation carried out of this slice: add
bucket boundaries near 1.5 s and 2 s** (a change to 7b's histogram). Until then the
server-side saga p99 systematically overestimates in the 1–2.5 s range. The `< 5 s` SLO is
unaffected and the overestimate is conservative.

## Step 3 — all four chaos scenarios

Exit codes read directly, never through a pipe:

| Scenario | Exit | Result |
|---|---|---|
| `kafka` | **0** | invariants clean |
| `inventory` | **0** | invariants clean |
| `poison` | **0** | clean before; `poison parked (2), partition kept moving`; drained 2; clean after |
| `order` | **0** | alerts fired (below); invariants clean after recovery |

`poison` parks **2**, not 1: `order.events` has two consumer groups
(`inventory-consumers`, `notification-dispatcher`) and each parks its own copy.

## Step 4 — Phase 7's Done-when

> killing Kafka mid-saga recovers with zero lost or double effects

Confirmed. During the `kafka` scenario **every order returned 201 while the broker was
down** — `POST /orders` is a local Postgres transaction that defers publishing to the outbox,
so the customer never sees the outage — and after the broker returned, INV1 through INV6 were
all clean: no order stranded, no duplicate payment, no reservation split, no unsent outbox
row, no DLQ entry, every CONFIRMED order backed by a SUCCEEDED payment.

Final state after the whole sequence: 1605 CONFIRMED, 618 CANCELLED, **0 non-terminal**,
0 ACTIVE reservations, 0 unsent outbox rows across all seven databases, both DLQs empty.

## Step 5 — what fired, and what did not

Under C4 (stop `order`, 90 s, traffic throughout — 236×201, 4×502, 360×503):

| Alert | Result |
|---|---|
| `CheckoutErrorBudgetFastBurn` | **fired** (`severity: page`) |
| `CheckoutErrorBudgetSlowBurn` | **fired** (`severity: ticket`) |
| `CheckoutLatencySLOBreach` | **did not fire** |

The slow burn fired here but only reached `pending` during the Task 7 run. The difference is
accumulated history: its long leg is a 1h rate, and by the acceptance run the hour contained
the earlier C4's errors as well, so the ratio crossed 6% where a single 90 s outage alone had
not. Worth knowing that a slow-burn alert's behaviour depends on what happened in the
preceding hour, not only on the current outage.

**The latency alert did not fire, and that is correct.** An open circuit answers in
single-digit milliseconds — a 503 is fast. Stopping a service destroys availability without
touching latency, so **latency alerts do not catch hard outages**; availability and latency
need separate alerts because they fail in different directions.

## Step 6 — full regression

| Gate | Result |
|---|---|
| `pnpm typecheck` (incl. `typecheck:infra`) | exit 0 |
| `pnpm lint` | exit 0 — 0 errors, 10 pre-existing warnings |
| `pnpm format:check` | exit 0 |
| hello / inventory / order / payment | 1 / 29 / 60 / 42 passed |
| catalog / notification / identity / gateway | 33 / 19 / 28 / 41 passed |
| `packages` | 117 passed |
| `infra` | 17 passed |

**253 service tests + 117 package tests + 17 infra tests, all green.**

And the property this slice spent most of its effort on: the invariant checker is **clean
immediately after the full service regression**, with no cleanup step and no ordering
constraint between the suites. Sixteen test files used to leave rows that tripped INV1, INV4
and INV6 — a full regression left 56 unsent outbox rows across five databases — which is why
Task 9's step 6 was originally expected to need reordering. It does not.

## Findings

**1. The infra suite requires the relays to be stopped.** Two of its tests seed a state the
running system immediately repairs: `INV4: flags an outbox row left unsent in <db>` and
`DRAIN_TIMEOUT`. With the `app` profile up, that service's outbox relay publishes the seeded
row within a tick, so INV4 correctly reports nothing and the drain-wait correctly finds
nothing in flight. Both then failed as a bare `expected undefined to be defined`, which reads
like a broken checker rather than a working relay — and cost real time to diagnose during this
run. Both now detect the case and fail naming the relay and the fix. For DRAIN_TIMEOUT no
pre-check is possible, because the race is *during* the wait, so it is diagnosed afterwards by
asking what happened to the row. With the app profile stopped: 17/17.

This is an environmental precondition, not a defect in the checker. It is now recorded in the
runbook and in both test files. Worth noting that CI is unaffected: its integration job does
not start the app profile.

**2. Six plan defects were found and fixed across the slice**, each of which would have
shipped a check incapable of failing or a script incapable of running:

1. The poison scenario ended in `assert_clean || true`, swallowing every exit code (caught
   pre-flight, before Task 1).
2. Task 2's cleanup SQL queried `Order` from inside the `payment` connection — separate
   databases, so the statement cannot execute.
3. INV5 covered only Kafka, leaving a poison `ChargePayment` parked on `payment.charge.dlq`
   invisible to the one invariant that exists to catch it — though spec §A1a always specified
   two sources.
4. The k6 script ignored the gateway's rate limiters (10/min auth, 300/min general, both
   hardcoded), so a run would have been almost entirely 429s and every threshold would have
   measured rejection latency instead of the saga.
5. `chaos.sh`'s compose invocation had no `-p`, so `stop kafka` matched nothing and every
   scenario would have "survived" an outage that never happened.
6. The poison scenario expected exactly 1 parked message; the answer is 2.

**3. One measurement criterion in the plan is not satisfiable as written** — the 250 ms
agreement between k6's and Prometheus's saga p99 — for the bucket-resolution reason above.
Met at p50, where the histogram resolves.

## Not covered, stated plainly

- **e2e suites were excluded** from the regression above (`--exclude "**/*.e2e.test.ts"`).
  They need their own orchestration and were out of this slice's scope.
- **The inventory scenario exercised delay, not compensation.** With `RESERVATION_TTL_MS` at
  its 900 s default, a 15 s outage cannot expire a reservation. The runbook records how to
  reach the compensation path (restart inventory with a small TTL and an outage longer than
  it); it was not run here.
- **The rate limiter under concentrated single-address load is untested.** Both the k6 script
  and the chaos driver present a distinct `X-Forwarded-For` per iteration, which is what makes
  the SLO numbers measurable at all, but it means these runs say nothing about limiter
  behaviour when real load arrives from one address.
- **These numbers are a same-machine regression signal, not a benchmark** — one laptop running
  eight services, two brokers and the observability stack in containers, with the load
  generator alongside them.
