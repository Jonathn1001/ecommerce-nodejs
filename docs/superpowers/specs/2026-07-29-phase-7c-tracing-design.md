# Phase 7c · OpenTelemetry traces & Jaeger — Design (child spec)

> Phase 7 (Hardening, XL) is decomposed into four slices — 7a correctness & hygiene debt
> (done, merged), 7b metrics & dashboards (done, merged at `4879c2f`), **7c tracing**
> (this doc), 7d verification (k6 + chaos). See
> `docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md` §Phase 7 for the slice model and
> `docs/superpowers/specs/2026-07-28-phase-7b-metrics-design.md` for the sibling slice whose
> shared-module-then-adopt shape this one deliberately copies.

## Purpose

7b answered "is the system healthy?" — rates, errors, durations, saga latency in aggregate.
It cannot answer "what happened to **this** order?". A checkout crosses gateway → order →
inventory → payment → notification through two brokers and seven outboxes; today the only
thread tying those together is a uuid `traceId` that a human greps for across seven log
streams.

7c makes that thread machine-readable. One checkout becomes one Jaeger trace, with a span per
hop and — critically — **visible gaps** where the system is waiting rather than working.

The roadmap's Done-when for this slice is exact: *one Jaeger trace spans
gateway→order→inventory→payment→notification*. That sentence is the acceptance test, and it
is what forces the hard part below.

## Scope

**In:**

- A shared tracing bootstrap in `packages/shared`, loaded as a Node `--import` preload.
- Auto-instrumentation for HTTP, Express and Prisma; **manual** spans for the messaging seams.
- `traceparent` on `EventEnvelope` (optional) and on every `Outbox` table.
- Producer spans in the outbox relay; consumer spans in the Kafka and RabbitMQ adapters.
- `traceId` re-based onto the W3C trace ID, with `x-trace-id` kept as a compatibility alias.
- Jaeger all-in-one in compose, plus `docs/infra.md`.

**Out:**

- Metrics/exemplar linkage between Prometheus and Jaeger (7d, once there is load worth
  sampling from).
- Log→trace correlation beyond emitting `traceId` — no log shipper, no Loki.
- k6, chaos, SLO burn alerts — all 7d.
- Any business-logic change. As in 7b, every pre-existing test must pass unmodified.

---

## A. The shared tracing module

### A1. Bootstrap by preload, not by import

The SDK must patch `http`, `express` and Prisma **before** those modules are loaded. Every
service's container CMD is `pnpm exec tsx src/main.ts`, and ESM hoists imports — so a
`startTracing()` call at the top of `main.ts` would run *after* the modules it needs to patch.

`packages/shared/src/tracing.ts` therefore exports a side-effecting bootstrap, loaded via:

```
NODE_OPTIONS=--import tsx --import file:///repo/packages/shared/src/tracing.ts
```

set per service in `docker-compose.example.yml`. Dockerfiles and CMDs are untouched.

**This exact form was verified empirically, not assumed** — three findings, each of which
would otherwise have been discovered during implementation:

1. **A bare specifier does not resolve.** `--import @ecom/shared/tracing` fails with
   `ERR_MODULE_NOT_FOUND`, because `packages/shared/package.json` has no `exports` map and
   its `main` is `src/index.ts`. Adding an `exports` map to satisfy the preload would change
   how all eight services resolve the package — a far larger blast radius than the preload
   itself justifies. A `file://` URL sidesteps it entirely.
2. **`--import tsx` must come first.** The bootstrap is a `.ts` file, so tsx's ESM loader has
   to be registered before Node tries to load it. Node preserves `--import` order.
3. **The absolute path is stable and knowable.** Every service Dockerfile does
   `WORKDIR /repo` → `COPY packages ./packages` → `WORKDIR /repo/services/<svc>`, so
   `/repo/packages/shared/src/tracing.ts` is correct in all eight containers.

### A1a. The bootstrap must be idempotent

The same experiment showed the preload module is evaluated **more than once** under tsx —
once per loader thread plus once on the main thread. A bootstrap that calls `sdk.start()`
unconditionally would therefore register duplicate exporters and duplicate instrumentations.

`tracing.ts` guards on a module-level flag stored on `globalThis`, so that repeat evaluations
in separate module registries still see the first one's mark. A unit test asserts a second
evaluation is a no-op.

**Consequence, deliberate:** a service run bare on the host — every test, every ad-hoc
`pnpm dev` — has no `NODE_OPTIONS` and therefore exports no spans. That is the correct
default: tests must not ship telemetry to a collector that may not exist. Tests that need to
assert on spans start their own SDK with an in-memory exporter (§F).

### A2. Which instrumentations are enabled

`@opentelemetry/auto-instrumentations-node` bundles far more than this system wants. The
enabled set is explicit, not default:

| Instrumentation | State | Why |
|---|---|---|
| `http`, `express` | **on** | The sync seam: gateway → service, and the gateway's own proxy hops. |
| `@prisma/instrumentation` | **on** | Prisma's query engine does **not** go through node-postgres, so `instrumentation-pg` sees nothing. Prisma needs its own instrumentation to emit query spans. |
| `redis-4` | **on** | Inventory's distributed lock is a real latency source worth seeing. Note the client is node-redis (`redis@^4.7.0`, `packages/shared/src/redis.ts:1`), **not** ioredis — they need different instrumentations and the wrong one silently emits nothing. |
| `kafkajs`, `amqplib` | **OFF** | Load-bearing decision — see A3. |
| `fs`, `dns`, `net` | **off** | Noise. `fs` in particular buries a trace in hundreds of spans. |

### A3. Why the messaging auto-instrumentations are disabled

This is the single most important decision in the slice, and getting it wrong produces
traces that look plausible and are wrong.

The kafkajs and amqplib instrumentations propagate context through **broker headers** and
create their own producer/consumer spans. This system propagates through the **envelope
JSON** (§C). Enabling both means two competing mechanisms: two producer spans per publish,
and a consumer span whose parent is chosen by whichever mechanism the instrumentation
consulted first. Worse, the header-based one would silently win on the sync path and silently
lose across the outbox — producing a trace that is correct for simple hops and subtly broken
for exactly the async hops this slice exists to fix.

The messaging seams are owned manually, in `kafka.ts` and `rabbitmq.ts`, where the envelope
already is.

### A4. Configuration

All standard OTel env vars, no bespoke config schema:

- `OTEL_SERVICE_NAME` — set per service in compose; becomes the Jaeger service name.
- `OTEL_EXPORTER_OTLP_ENDPOINT` — `http://jaeger:4318`, OTLP over HTTP.
- `OTEL_TRACES_SAMPLER` — `parentbased_always_on` by default. 7d will lower this under k6
  load; making it an env var now means 7d needs no code change.
- Absent `NODE_OPTIONS`, none of this is read at all.

---

## B. Trace identity and the HTTP seam

### B1. One ID, W3C format

`traceId` stops being a minted uuid and becomes the **OTel trace ID** — 32 lowercase hex, no
dashes. A `traceId` in a log line pastes directly into Jaeger's search box.

`packages/shared/src/trace.ts` is rewritten:

- `traceMiddleware` no longer calls `uuidv4()`. It reads the active span context — which the
  http/express instrumentation has already established, including extracting an inbound
  `traceparent` — and assigns `req.traceId = span.spanContext().traceId`.
- `TRACE_HEADER` (`x-trace-id`) is still read and still echoed on the response, so external
  callers and the existing e2e tests keep working. On the way in it is now a **fallback**:
  standard `traceparent` wins when both are present.
- If there is no active span at all — the untraced case, i.e. every test run — the middleware
  falls back to `uuidv4()` exactly as today. Nothing that works now stops working.

### B2. The compatibility surface

`EventEnvelopeSchema.traceId` stays `z.string().min(1)`. It is not tightened to 32-hex,
because fixtures across the suite pass `traceId: "t"` and tightening it would be a
test-rewriting exercise with no runtime benefit. The bridge in §C tolerates a non-conforming
`traceId` by starting a fresh trace rather than throwing.

---

## C. Async propagation — the hard part

### C1. Why a new field is needed at all

`traceId` alone is insufficient. W3C `traceparent` is
`version-traceid-spanid-flags`; the trace ID identifies the *trace*, the span ID identifies
the *parent within it*. Carrying only the trace ID would put every span in one flat trace with
no causality — a list, not a tree.

### C2. The carrier is the envelope, not broker headers

`EventEnvelopeSchema` gains:

```ts
traceparent: z.string().optional(),
```

**Optional, not required.** The codebase already paid for this lesson: when `ChargePayment`
gained `userId`, in-flight commands minted under the narrower contract had to be tolerated
with `.partial({ userId: true })` or they would retry 3× and dead-letter forever. A required
`traceparent` would do exactly that to every event in flight during the 7c deploy.

Broker headers were the alternative and were rejected: this system round-trips events through
places headers do not survive. The `Outbox` row is JSON in Postgres. The DLQ park path
republishes the **raw value** (`kafka.ts:117`). `moveDlqOnce` replays that raw value. Putting
the context inside the envelope makes it survive all three for free; putting it in headers
means adding and maintaining header plumbing on each of those paths.

Every `Outbox` table gains a nullable `traceparent String?` column — seven migrations, one
per outbox-owning service (all but gateway, which has no database).

### C3. Span shape across the seam

```
order HTTP span                    (SERVER)
  └─ business tx  ── writes Outbox row, traceparent = THIS span's context
                                   ← row sits until the relay polls (≤500ms)
relay publish span                 (PRODUCER)  parent = stored context
  └─ injects ITS OWN context as the published envelope's traceparent
inventory consume span             (CONSUMER)  parent = relay's producer span
  └─ prisma spans, next Outbox row, …
```

Three properties this buys, each of which is the point:

1. **The relay's polling delay is visible** as the gap between the business span ending and
   the producer span starting. Today that latency is invisible; it is also the single largest
   contributor to end-to-end checkout time.
2. **The row at rest keeps the original context.** The relay overwrites `traceparent` only on
   the envelope it publishes, never on the stored row. A replayed row therefore re-parents to
   the original business operation, not to a previous replay.
3. A consumer that writes its own outbox row repeats the pattern, so the chain extends
   through the full saga without special-casing any hop.

### C4. Failure behaviour

Every constraint 7b established carries over verbatim, because this slice touches the same
production paths:

- **Nothing may throw into a production path.** Span creation, context injection and context
  extraction are each wrapped and log-and-continue on failure. A malformed `traceparent` from
  an untrusted or older producer starts a fresh trace; it never rejects the message.
- Recording happens **after** the transaction resolves, never inside the tx callback — the
  same placement rule that governs the 7b metrics, for the same reason.
- The DLQ and retry paths keep their exact current behaviour. A span must never be the reason
  a message is or is not parked.

---

## D. Compose and `infra/`

Jaeger **all-in-one**, pinned (no `:latest` — same reasoning as the 7b dashboard), accepting
OTLP natively so there is no separate Collector to run or configure. A Collector buys
pipeline processing this system has no use for yet; it can be introduced in 7d if k6 volume
justifies it.

- `4317`/`4318` (OTLP) are reached **in-network** at `jaeger:4318` and are deliberately **not
  published** to the host — same posture as the gateway's metrics port in 7b.
- `16686` (UI) is published.
- Prod overlay resets the UI port with `!reset []`, like every other operator-facing surface.
- `docs/infra.md` gains the endpoint row and the `--profile app` note that already applies to
  Prometheus and Grafana.

Adding Jaeger as a Grafana datasource is explicitly **out**: it is 7d's job, once there are
exemplars worth clicking through from a metrics panel.

---

## E. Decisions

| # | Decision | Why |
|---|---|---|
| 1 | Hybrid: auto for plumbing, manual for messaging | Auto cannot bridge the outbox; manual everywhere is a needlessly wide diff. |
| 2 | `traceId` **becomes** the W3C trace ID | One identifier. A log line pastes into Jaeger. The alternative is a permanent join. |
| 3 | `traceparent` travels in the **envelope** | Survives the outbox row, the DLQ raw park, and replay — three paths headers do not. |
| 4 | `traceparent` is **optional** | A required field dead-letters every event in flight during deploy. Precedent: `ChargePayment.userId`. |
| 5 | Bootstrap via `NODE_OPTIONS=--import` | Works with tsx's ESM loader; leaves 8 Dockerfiles and CMDs untouched. |
| 6 | kafkajs + amqplib auto-instrumentation **off** | Two competing propagation mechanisms produce traces that are right on sync hops and wrong on async ones. |
| 7 | Jaeger all-in-one, no Collector | OTLP-native; a Collector adds a container and config for no current payoff. |
| 8 | OTLP ports unpublished; only the UI is exposed | Same posture as 7b's separate metrics port. |
| 9 | Sampling via `OTEL_TRACES_SAMPLER` env | 7d changes sampling without a code change. |

---

## F. Testing

The lesson 7b ended on governs this section: **a test that constructs the machinery proves
nothing about whether the call site is wired.** Every seam gets a test that fails if the
wiring is removed.

- **Bootstrap** — unit: the enabled-instrumentation set is exactly §A2's list, asserted by
  name. This is the test that fails the day someone swaps in the full auto set and silently
  re-enables kafkajs. A second unit test asserts re-evaluating the module is a no-op (§A1a).
- **`traceMiddleware`** — unit: derives `traceId` from an active span context; falls back to a
  uuid with no active span; prefers `traceparent` over `x-trace-id` when both are present.
- **Envelope round-trip** — unit: an envelope with no `traceparent` parses (the deploy-safety
  property), and a malformed `traceparent` yields a fresh trace rather than a throw.
- **Outbox relay** — integration: a row written under an active span carries that context;
  the published envelope's `traceparent` is the **relay's** span, not the stored one; the
  stored row is unchanged. Run with an in-memory span exporter, no Jaeger required.
- **Consumer seam** — integration, and this is the discriminating one: a message whose
  envelope carries a `traceparent` produces a consumer span whose parent is that context.
  Deleting the extraction call must fail this test while every other test stays green.
- **Full-suite regression** — all 356 tests from the 7b merge pass **unmodified**.
- **CI** — no new job. The `quality` lane runs with no database and no env files, so anything
  importing a service's `config` at module scope belongs in `.int`. That is precisely the trap
  that failed CI at the end of 7b; it is written down here so 7c does not repeat it.

## G. Definition of Done

- One Jaeger trace spans gateway → order → inventory → payment → notification for a real
  checkout driven through the gateway, with the relay gap visible between hops.
- A `traceId` copied from a log line finds that trace in Jaeger.
- `traceparent` is absent-tolerant: an envelope minted before this deploy still processes.
- No business-logic change; every pre-existing test passes unmodified.
- Nothing in this slice can throw into a production path.
- `docker compose --profile app up -d` brings Jaeger up with the UI reachable.

### Known limitation carried in

`hello`'s container CrashLoops on a pre-existing corepack/network issue (`services/hello/
Dockerfile` untouched by 7b, its Prometheus target was already down). Its traces cannot be
verified in-container this slice either. `hello` is a canary, not on the checkout path, so
this does not affect the Done-when — but it is now the second slice it has degraded, and it
should be fixed before 7d.
