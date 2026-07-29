# Phase 7d · Verification — k6, chaos, SLO alerts — Design (child spec)

> Phase 7 (Hardening, XL) is decomposed into four slices — 7a correctness & hygiene debt
> (done, merged), 7b metrics & dashboards (done, merged at `4879c2f`), 7c OTel tracing
> (done, merged at `6e6cb4d`), **7d verification** (this doc). See
> `docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md` §Phase 7.

## Purpose

7b made the system observable. 7c made a single checkout followable. Neither proves the
system **holds up** — that it meets its stated SLOs under load, and that killing a broker
mid-saga loses nothing and double-charges nobody.

Phase 7's Done-when has four criteria. Two are met:

| Criterion | Status |
|---|---|
| One Grafana dashboard shows a full checkout's RED + saga metrics | ✅ 7b |
| One Jaeger trace spans gateway→order→inventory→payment→notification | ✅ 7c |
| **k6 meets the SLOs** | this slice |
| **Killing Kafka mid-saga recovers with zero lost or double effects** | this slice |

7d closes the phase.

## Scope

**In:**

- An **invariant checker** asserting the saga's safety properties across all 7 databases.
- A **k6 checkout script** with the SLOs encoded as `thresholds`, so a breach is a non-zero exit.
- A **chaos suite** driving traffic while killing the broker and a service, plus the
  malformed-envelope case.
- **SLO burn-rate alert rules** in Prometheus, validated by an induced breach.
- **A runbook** covering all three.

**Out, and stated so nobody assumes otherwise:**

- **The two umbrella-locked lesson items** — the orchestrated-saga comparison variant and the
  schema-evolution `v1→v2` event. **User ruling, 2026-07-29:** these are learning exercises, not
  hardening; neither appears in Phase 7's Done-when; and the roadmap itself names
  "orchestrated-saga variant scope explosion" as a risk. They move to 7e/7f or the named backlog.
  The roadmap's Phase 7 prose is corrected accordingly (§F).
- **`ProcessedEvent` retention.** Already shipped — `startLedgerPruner` is wired at 10 call sites
  across the services, landed by 7a's Task 4. The Phase 7 prose still lists it under 7d; the
  absorption map already records it correctly. Prose corrected in §F.
- **Alertmanager.** See §D3 — deliberate cut, not an oversight.
- Any business-logic change. Every pre-existing test must pass unmodified.

---

## A. The invariant checker — the spine

Both k6 and chaos need to answer one question: *did the system lose or duplicate anything?*
Answering it by eye does not scale and does not survive review. So it is a script, and both
suites end by running it.

`infra/scripts/check-invariants.ts`, run via `tsx`, connecting to each service database with
`pg` (raw SQL, not Prisma — this needs to read several databases, and wiring 7 generated clients
into a verification script is not worth it).

**`pg` is not currently a shared dependency** — it appears only in `services/order`
(`services/order/package.json:16`, `^8.22.0`), added for the SSE `LISTEN` client. The checker
needs its own declaration. It is a verification script rather than shipped code, so it belongs in
the root workspace as a devDependency at the same version, not in `packages/shared` where it
would become a production dependency of all 8 services for no runtime reason.

### A1. The invariants

Each is a SQL query that must return **zero rows**. A non-empty result is a failure, and the
script prints the offending rows.

**Two candidate invariants were cut because the database already enforces them, and a check
that cannot fail proves nothing.** This was caught in spec self-review and is worth recording,
because both read as obviously valuable:

- *"No `orderId` with more than one `Payment` row"* — `Payment.orderId` is `@unique`
  (`services/payment/prisma/schema.prisma:15`). Postgres rejects the second insert; the query
  can never return a row.
- *"No `eventId` twice in `ProcessedEvent`"* — `eventId` is the `@id`
  (`services/order/prisma/schema.prisma:83`). Same reasoning.

The real risk in both cases is not a duplicate row — it is the duplicate insert being
**mishandled**: the constraint violation throwing, the message parking to the DLQ instead of
being treated as the idempotent no-op it is. That is what invariants 5 and 6 below actually
check.

| # | Invariant | Why it is falsifiable, and what it catches |
|---|---|---|
| 1 | No `Order` left in `PENDING` or `AWAITING_PAYMENT` after drain | Nothing in the schema enforces termination. Statuses verified against the real union: `OrderStatus = "PENDING" \| "AWAITING_PAYMENT" \| "CANCELLED" \| "CONFIRMED"` (`services/order/src/transition.ts:11`). |
| 2 | No order both `CANCELLED` **and** carrying a `SUCCEEDED` payment | **The sharpest "double effects" check**: money taken for an order the customer was told was cancelled. Cross-service, so no constraint can enforce it. |
| 3 | For one `orderId`, no `Reservation` rows split across `CONSUMED` and `RELEASED` | `Reservation.orderId` is only `@@index`ed, not unique (`services/inventory/prisma/schema.prisma:26,34`), so an order genuinely has one row per product line and they can diverge. Consuming a released reservation is the oversell bug 3b closed. |
| 4 | No `Outbox` row with `sentAt IS NULL` after the relay has drained | **The "no lost effects" half.** A row stuck unsent is an event the world never saw. Nothing enforces it. |
| 5 | DLQ depth is zero after a clean run, and exactly the injected count after C3 | Catches the mishandled-duplicate case above: an idempotent redelivery that parks instead of no-op'ing shows up here and nowhere else. |
| 6 | Every `CONFIRMED` order has a `SUCCEEDED` payment and all its reservations `CONSUMED` | The cross-service consistency the saga exists to provide, and the only invariant that requires reading more than one database. |

Invariants 2 and 6 are why the checker reads all seven databases rather than being seven
per-service assertions — they are the ones a split-brain outcome trips.

### A2. Drain-awareness

Invariants 1 and 4 are only meaningful **after** the system has settled. The checker therefore
takes a `--wait-for-drain <seconds>` flag: it polls until no `Outbox` row is unsent and no
`Order` is non-terminal, or the deadline passes. If the deadline passes it reports **what was
still in flight** and fails — a timeout is a result, not an error.

Without this, a chaos run that killed Kafka would "fail" simply because it checked too early,
and the suite would be untrustworthy in exactly the scenario it exists for.

---

## B. k6 — load against the SLOs

`k6/checkout.js`, run through the pinned `grafana/k6` container joined to the compose network,
so it addresses `http://gateway:8000` directly and no host port is involved.

### B1. The flow

The same one 7c's acceptance drove, because it is the flow the SLOs are about:
register → login → `POST /cart/items` → `POST /orders` → poll `GET /orders/:id` until terminal.

Three details are load-bearing and were each discovered the hard way in earlier slices:
`register` requires a `name` field; every mutation needs the double-submit CSRF header (echo the
`XSRF-TOKEN` cookie into `x-csrf-token`); and the cart is its own gateway mount (`/cart`, not
`/orders/cart`).

Inventory must be seeded with stock before the run — the script fails fast with a clear message
if the product it picked has none, rather than reporting a 100% business-failure rate as though
it were a latency result.

### B2. The SLOs, as thresholds

```js
thresholds: {
  http_req_duration: ["p(95)<500"],        // roadmap: p95 < 500 ms
  saga_duration:     ["p(99)<5000"],       // roadmap: saga p99 < 5 s
  http_req_failed:   ["rate<0.01"],        // roadmap: error < 1 %
}
```

`saga_duration` is a custom k6 `Trend`, measured from the `POST /orders` response to the poll
that first observes a terminal status. It is **not** `http_req_duration` — the saga's duration is
dominated by the relay's ≤500 ms poll interval and the broker hops, none of which appear in any
single HTTP call. Measuring the wrong thing here would make the p99 threshold meaningless.

A threshold breach exits non-zero. That is what makes "k6 meets the SLOs" a testable claim.

### B3. Honest limits, stated in the runbook

These numbers are measured on one laptop running 8 services, two brokers and Postgres in
containers. They are a **regression signal, not a benchmark** — comparable across runs on the
same machine, not across machines. The runbook says so, because a number in a report gets quoted
later without its caveat.

---

## C. Chaos — kill things mid-saga

`infra/scripts/chaos.sh`, three scenarios, each: start steady checkout traffic → break something
→ restore → wait for drain → run the invariant checker.

| Scenario | Break | What it proves |
|---|---|---|
| C1 | `docker compose stop kafka`, ~15s, restart | The outbox relay retries rather than dropping, consumers rebound after rebalance, and no order is stranded. **This is the roadmap's Done-when case.** |
| C2 | `docker compose stop inventory`, ~15s, restart | A mid-saga service outage: orders pile at `PENDING`, then drain. Inventory is the interesting target because its reservation has a TTL and a sweeper, so a long enough outage exercises the compensation path rather than just a delay. |
| C3 | Publish a malformed envelope to `order.events` | The Phase 3b parse fix: a poison message parks to the DLQ and the partition **keeps moving**. Asserted by confirming later valid messages still process — the check that distinguishes "parked" from "stalled". |

Failures are injected with `docker compose stop`/`start`. Toxiproxy was considered and rejected:
it would require rewriting every service's broker URL to point at a proxy, touching the compose
entry for all 8, and the Done-when is about an **absent** broker, not a slow one. Recorded as a
follow-up if a latency-fault scenario is ever wanted.

**C2 exercises the delay regime, not compensation — and the spec says so rather than implying
otherwise.** `RESERVATION_TTL_MS` defaults to **900_000 (15 minutes)**
(`services/inventory/src/config.ts:9`), so a ~15-second outage is nowhere near the reservation
TTL: orders queue and then drain. That is a real and worthwhile property, but it is *not* the
compensation path.

Reaching compensation would need either a 15-minute outage — impractical in a suite anyone will
actually run — or the service restarted with a deliberately small `RESERVATION_TTL_MS`. The
script therefore takes the TTL as a parameter, and the runbook documents both regimes explicitly,
because "inventory recovered" means something entirely different in each and the difference is
invisible from the outside.

---

## D. SLO burn-rate alerts

### D1. Rules, not thresholds

`infra/prometheus/rules/slo.yml`, wired in via a `rule_files:` key that
`infra/prometheus/prometheus.yml` does not currently have (verified — it has only `global` and
`scrape_configs`), plus a volume mount for the rules directory.

Multi-window, multi-burn-rate, over the metrics 7b already ships:

| Alert | Windows | Burn rate | Meaning |
|---|---|---|---|
| `CheckoutErrorBudgetFastBurn` | 5m **and** 1h | 14.4× | Budget gone in ~2 days — page-worthy |
| `CheckoutErrorBudgetSlowBurn` | 30m **and** 6h | 6× | Budget gone in ~5 days — ticket-worthy |
| `CheckoutLatencySLOBreach` | 30m | — | p95 over 500 ms, sustained |

The two-window requirement on each burn alert is the point of the pattern: a single short window
fires on any brief blip, and a single long window is too slow to matter. Requiring both to breach
simultaneously is what makes the alert worth waking someone for. A naive `error rate > 1% for 5m`
rule would be simpler and would teach nothing.

### D2. Validation — the alert must be shown to fire

An untested alert is decoration; that is 7b's stated reason for deferring these here, so shipping
them unfired would defeat the deferral.

**The chaos suite supplies the breach.** Stopping an upstream makes the gateway return **502**
— verified, not assumed: `services/gateway/src/app.ts:117,124,138,163` all return 502 when an
upstream is unreachable. That matches the `status=~"5.."` selector the burn-rate rules use, so
the real error rate climbs past the budget without any synthetic error endpoint, and the alert is
validated against the same failure the chaos suite already induces.

Validation asserts on Prometheus's `ALERTS{alertname="…",alertstate="firing"}` series.

One consequence to design around: the fast-burn alert requires **both** a 5m and a 1h window to
breach. A 15-second outage will not move a 1h window far enough. Alert validation therefore needs
either a longer induced outage or rules whose windows are shortened for the validation run — the
plan must pick one explicitly rather than discovering it when the assertion silently never fires.

### D3. No Alertmanager — a deliberate cut

7b deferred "SLO burn alerts **and Alertmanager**" to this slice. The rules ship; Alertmanager
does not.

On a local learning stack there is nowhere to route to — no Slack, no pager, no on-call. Prometheus
evaluates the rules itself and exposes `ALERTS`, which is fully observable and fully testable.
Alertmanager would add a container, a config file, and a receiver pointing at nothing, and would
make the alerts *less* verifiable rather than more, because the assertion would then depend on a
second component's delivery behaviour. Recorded as a follow-up for whenever there is a real
destination.

---

## E. Runbook

`docs/runbooks/phase-7d-verification-demo.md`, matching the existing `phase-N-<topic>-demo.md`
naming. Covers: running k6 and reading its output; running each chaos scenario and what a pass
looks like; what each alert means and what to do about it; and B3's caveat that the numbers are a
same-machine regression signal, not a benchmark.

---

## F. Roadmap prose correction

Phase 7's Scope-in and Slices lines still list `ProcessedEvent` retention under 7d (it shipped in
7a) and still bundle the two lesson items into this slice. Both are corrected, and 7d is restated
as **k6 + chaos + SLO alerts + runbooks**. The lesson items are moved to the named backlog with
their own row, so they are deferred visibly rather than dropped.

---

## G. Decisions

| # | Decision | Why |
|---|---|---|
| 1 | 7d is verification only | Neither lesson item is in Phase 7's Done-when; the saga variant is a named scope-explosion risk. |
| 2 | An invariant **checker**, shared by both suites | "Zero lost or double effects" has to be machine-checked or it is an opinion. |
| 3 | The checker waits for drain, and a timeout is a reported failure | Otherwise a chaos run fails merely for checking too early. |
| 4 | k6 local-only, SLOs as `thresholds` | A shared CI runner's absolute latency is noise; thresholds there would be loosened into meaninglessness or produce distrusted failures. |
| 5 | `saga_duration` is a custom Trend, not `http_req_duration` | The saga's time is in relay polls and broker hops, invisible to any single HTTP call. |
| 6 | `docker compose stop`, not Toxiproxy | The Done-when is about an absent broker; Toxiproxy would touch all 8 compose entries. |
| 7 | Multi-window burn rate | Single-window rules are either jumpy or too slow; the two-window shape is the thing worth learning. |
| 8 | Chaos induces the breach that validates the alerts | No synthetic error path, and the alert is proven against a real failure. |
| 9 | No Alertmanager | Nowhere to route; it would make the alerts less verifiable, not more. |

---

## H. Testing

The lesson this phase has repeatedly paid for: **a check that cannot fail proves nothing.** Six
plan-supplied tests in 7c would have passed against broken implementations. Every artifact here
gets a discrimination proof.

- **Invariant checker** — unit tests over a fixture database with each violation seeded in turn.
  Six invariants, six tests that each fail if their query is removed. This is the highest-value
  test surface in the slice, because every other artifact trusts the checker's verdict.
- **Drain-wait** — a test where drain never completes, asserting the checker reports what was in
  flight and exits non-zero rather than hanging or passing.
- **k6 thresholds** — verified by running with a deliberately impossible threshold (`p(95)<1`) and
  confirming a non-zero exit. Proves the thresholds are wired to the exit code, which is the only
  thing making them a gate.
- **Chaos scenarios** — each is proven by running it, and by confirming the invariant checker
  passes afterwards. C3 additionally asserts a *later* valid message processed, which is what
  distinguishes a parked poison message from a stalled partition.
- **Alert rules** — `promtool check rules` for syntax, then the induced-breach validation of §D2
  asserting `ALERTS` actually fires. Syntax-valid rules that never fire are the decoration this
  slice exists to avoid.
- **Full regression** — every pre-existing test passes unmodified.

## I. Definition of Done

- `k6/checkout.js` runs against the local stack and **exits zero**, with all three SLO thresholds
  met and the numbers recorded.
- All three chaos scenarios run, and the invariant checker passes after each.
- Killing Kafka mid-saga demonstrably loses nothing and duplicates nothing — Phase 7's Done-when.
- Both burn-rate alerts and the latency alert are **observed firing** under induced breach.
- The runbook lets someone reproduce all of the above without reading this spec.
- Phase 7's roadmap prose matches what actually shipped.
- No business-logic change; every pre-existing test passes unmodified.

### Known limitation carried in

`hello`'s container has CrashLooped since 7b on a pre-existing corepack/network issue
(`services/hello/Dockerfile` untouched by 7b and 7c). It is not on the checkout path, so it does
not affect any criterion here — but this is the **third consecutive slice** running with it
degraded, and it should be fixed before it becomes permanent.
