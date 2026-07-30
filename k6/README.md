# k6 — checkout load script

`checkout.js` drives the full customer path through the gateway — register, login, add to
cart, place an order, then poll until the saga reaches a terminal status — and encodes the
roadmap's SLOs as k6 thresholds so a breach is a non-zero exit code rather than a number
somebody has to read.

## These numbers are a regression signal, not a benchmark

Everything below was measured on one laptop running eight services, two brokers, Postgres,
Redis and the observability stack in containers, with the load generator on the same
machine. Compare a run to another run **on the same machine and the same stack**. Do not
compare to production, to a cloud instance, or to anybody else's numbers.

## Prerequisites

The full stack must be up, including the app profile:

```bash
docker compose -f docker-compose.example.yml --profile app up -d
```

`identity` needs `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY`, and `payment` needs
`PAYMENT_WEBHOOK_SECRET`, all read from the gitignored compose env file at the repo root.
`identity` crash-loops on a missing key and the gateway will not start without it.

## Seed stock first, then run

The script refuses to start without `PRODUCT_ID`, and its `setup()` resolves that product
through the gateway before any load is generated. Both guards exist because a run against a
product with no stock **cancels every order for insufficient inventory and still reports
three green thresholds** — a pass on a run that tested nothing.

```bash
PID=$(curl -s "http://localhost:8000/products?limit=1" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")

docker exec ecom-platform-postgres-1 psql -U ecom -d inventory -c \
  "INSERT INTO \"Inventory\" (\"productId\", available, \"updatedAt\")
   VALUES ('$PID', 100000, now())
   ON CONFLICT (\"productId\") DO UPDATE SET available=100000, \"updatedAt\"=now();"

PRODUCT_ID=$PID k6 run k6/checkout.js
```

`Inventory.updatedAt` is `NOT NULL` with no default, so a bare `INSERT` without it fails.

Knobs: `BASE_URL` (default `http://localhost:8000`), `VUS` (default 5), `DURATION`
(default `1m`). Running k6 inside a container instead needs the compose network and the
service name — `docker run --rm --network ecom-platform_default -v "$PWD/k6:/scripts" -e
PRODUCT_ID="$PID" -e BASE_URL=http://gateway:8000 grafana/k6:0.55.0 run /scripts/checkout.js`.

## Each iteration presents itself as a distinct client, on purpose

The gateway rate-limits per client IP: **10/min on the auth routes and 300/min on
everything** (`services/gateway/src/app.ts:97-103`), both hardcoded. A single checkout
iteration spends two auth calls, two mutations and up to 120 status polls, so a run from one
apparent client is almost entirely `429`s — and the thresholds would then be measuring
rejection latency instead of the saga.

`app.set("trust proxy", 1)` exists so that each client behind a TLS terminator gets its own
bucket, so the script sets a distinct `X-Forwarded-For` per iteration. That models load
arriving from many machines, which is what a real load test looks like. **The consequence
worth stating: these numbers say nothing about how the rate limiter behaves under
concentrated load from one address.** Testing that is a different exercise.

## The thresholds

| Threshold                      | Meaning                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http_req_duration: p(95)<500` | Gateway-observed request latency across every call the journey makes.                                                                                                                                                                                                                                                           |
| `saga_duration: p(99)<5000`    | The roadmap's saga SLO. A custom `Trend`, not an HTTP metric — the saga's time lives in relay polls and broker hops, so no single HTTP call contains it. Measured from the `POST /orders` response to the first poll that observes a terminal status, so it carries up to one 250 ms poll interval of overhead by construction. |
| `http_req_failed: rate<0.01`   | Any non-2xx/3xx, including a `429` — which is what makes the rate-limit story above load-bearing rather than cosmetic.                                                                                                                                                                                                          |

## Proven to be able to fail

A threshold nobody has seen fail is a claim, not a check. Temporarily tightening
`http_req_duration` to `p(95)<1` made k6 **exit 99** and print
`thresholds on metrics 'http_req_duration' have been crossed`, with the summary marking that
line `✗` while the other two stayed `✓`. Restored afterwards.

## Baseline run, 2026-07-30

5 VUs, 1 minute, native k6 v0.55.0, stack on published ports:

```
229 iterations, 2018 requests, 0 failures
http_req_duration  p(95)=203.92ms  p(99)=268.02ms   ✓ <500
saga_duration      p(95)=1.47s     p(99)=1.78s      ✓ <5000
http_req_failed    0.00%                            ✓ <0.01
exit code 0
```

All 381 sagas recorded server-side came back `outcome="confirmed"` — no order was cancelled,
so stock never ran out and the happy path is what was actually measured.

## Cross-validation against the server-side metric

7b records `saga_duration_seconds` server-side after commit, so the two measurements should
agree. They do, but **not at p99, and the reason is the histogram rather than the harness.**

`SAGA_BUCKETS` is `[0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]`
(`services/order/src/metrics.ts:4`). Every observed saga fell between 0.77 s and 1.89 s, so
79% land in `(0.5, 1]` and the remaining 21% in `(1, 2.5]` — a single bucket wider than the
entire observed spread. `histogram_quantile` then interpolates p99 linearly inside it:

```
le=1.0  cumulative 301/381 = 0.7900
le=2.5  cumulative 381/381 = 1.0000
p99 -> 1.0 + ((0.99*381 - 301) / (381 - 301)) * (2.5 - 1.0) = 2.4286
```

which reproduces Prometheus's reported `2.4285665352829304` exactly. Any true p99 anywhere in
`(1, 2.5]` yields that same estimate, so **a 250 ms comparison at p99 is not measurable with
these bucket edges** — the plan's stated criterion cannot be met there by either a correct or
an incorrect harness.

Where the buckets do have resolution, the criterion is met:

|     | k6 (client-side) | Prometheus (server-side)                  | Gap                                          |
| --- | ---------------- | ----------------------------------------- | -------------------------------------------- |
| p50 | 1.03 s           | 0.8165 s                                  | **214 ms — inside the 250 ms poll interval** |
| p99 | 1.78 s           | 2.4286 s (interpolated inside `(1, 2.5]`) | not resolvable; see above                    |
| max | 1.89 s           | 0 observations above 2.5 s                | consistent                                   |

The p50 gap is also in the **expected direction**: k6 can only notice a terminal status at a
poll boundary, so it must read slightly high against a metric recorded at commit time.

Tightening the p99 comparison needs a bucket boundary inside the observed range — around
1.5 s and 2 s. That is a change to 7b's histogram, not to this script, and it is worth doing
before anyone treats the server-side saga p99 as a precise number: **in the 1–2.5 s range it
systematically overestimates.** The `< 5s` SLO itself is unaffected — 2.43 s is comfortably
under it, and the overestimate is conservative.
