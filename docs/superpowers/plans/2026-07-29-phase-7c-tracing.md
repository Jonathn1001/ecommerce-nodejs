# Phase 7c — OpenTelemetry traces & Jaeger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One checkout produces one Jaeger trace spanning gateway → order → inventory → payment → notification, with the outbox relay's polling delay visible as a gap between hops.

**Architecture:** Auto-instrumentation (HTTP, Express, Prisma, redis) is loaded by a `NODE_OPTIONS=--import` preload and covers the synchronous seams. The asynchronous seams are owned manually: `traceparent` rides inside the `EventEnvelope` (not broker headers), is persisted on each `Outbox` row, and is re-injected by the relay so consumers can parent to it. `traceId` stops being a minted uuid and becomes the W3C trace ID, so a log line pastes straight into Jaeger.

**Tech Stack:** `@opentelemetry/sdk-node`, `@opentelemetry/api`, `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/exporter-trace-otlp-http`, `@prisma/instrumentation@^6.19`, Jaeger all-in-one. TypeScript, tsx, pnpm workspaces, vitest.

**Spec:** `docs/superpowers/specs/2026-07-29-phase-7c-tracing-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

1. **Nothing may throw into a production path.** Span creation, context injection and context extraction are each wrapped and log-and-continue on failure. A malformed `traceparent` starts a fresh trace; it never rejects a message. This is the constraint 7a and 7b were both adjudicated against — it is binding, not advisory.
2. **Record after the transaction resolves**, never inside a tx callback and never in a pure domain module.
3. **`traceparent` is OPTIONAL on the envelope.** A required field dead-letters every event in flight during deploy. Precedent: `ChargePayment.userId` needed `.partial({ userId: true })` for exactly this reason.
4. **kafkajs and amqplib auto-instrumentations are OFF.** They propagate via broker headers while this system propagates via the envelope; enabling both yields traces that are correct on sync hops and quietly wrong on async ones.
5. **Exact package names** — these were verified against npm and two obvious guesses are wrong:
   - `@opentelemetry/instrumentation-redis` — NOT `instrumentation-redis-4` (deprecated), NOT `ioredis` (wrong client).
   - `@prisma/instrumentation@^6.19` — NOT latest (7.x), because every service pins `@prisma/client: ^6.1.0`.
6. **Prisma migrations via CLI only.** `pnpm --filter @ecom/<svc> exec prisma migrate dev --name <change>`. Hand-writing or editing files under `prisma/migrations/` is blocked by `.claude/hooks/prisma-migration-guard.sh` and breaks Prisma's checksums.
7. **The `quality` CI lane runs with no database and no env files.** Any test that imports a service's `config` at module scope must be named `*.int.test.ts`. This is what failed CI at the end of 7b.
8. **Never commit** `docker-compose.yml`, `.env`, or any secret. `docker-compose.example.yml` and `.env.example` are the committed templates.
9. **No sensitive data in span attributes.** Span attributes are logs by another name — IDs and codes only, never payloads, emails, tokens or names. Enforced by `.claude/rules/sensitive-logging.md`.
10. **Commit specific files, never `git add -A`.** Every task ends with `pnpm -r typecheck && pnpm format:check` clean.
11. **No business-logic change.** All 356 tests from the 7b merge must pass **unmodified**.

**Local infra:** integration tests need `docker compose --profile app up -d`. An unrelated `eda-platform` stack on this machine holds 5432, 9090, 4318 and 1025/8025; 7b used a scratchpad `-f` override to remap rather than stopping it. Run `bash infra/scripts/reset-dev-topics.sh` before trusting any e2e failure — a long-lived broker accumulates replay history until the 25s poll budgets break.

---

### Task 1: `traceparent` on the event contract

**Files:**
- Modify: `packages/contracts/src/envelope.ts`
- Test: `packages/contracts/src/__tests__/envelope.unit.test.ts` (create if absent)

**Interfaces:**
- Produces: `EventEnvelope.traceparent?: string`; `makeEnvelope(input: { …, traceparent?: string })` passes it through.

Everything downstream depends on this, so it lands first and alone.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { EventEnvelopeSchema, makeEnvelope } from "../envelope";

const W3C = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("envelope traceparent", () => {
  it("carries traceparent through makeEnvelope", () => {
    const env = makeEnvelope({
      type: "order.placed",
      version: 1,
      traceId: "t",
      producer: "test",
      payload: {},
      traceparent: W3C,
    });
    expect(env.traceparent).toBe(W3C);
  });

  // Deploy safety: an event minted before this deploy has no traceparent at all.
  // If this ever becomes required, every in-flight event dead-letters.
  it("parses an envelope with NO traceparent", () => {
    const parsed = EventEnvelopeSchema.parse({
      eventId: "3f1a7c62-9b0e-4f5d-8a21-2c7e6d4b1f90",
      type: "order.placed",
      version: 1,
      occurredAt: new Date().toISOString(),
      traceId: "t",
      producer: "test",
      payload: {},
    });
    expect(parsed.traceparent).toBeUndefined();
  });

  it("omits traceparent when the caller supplies none", () => {
    const env = makeEnvelope({
      type: "order.placed",
      version: 1,
      traceId: "t",
      producer: "test",
      payload: {},
    });
    expect(env.traceparent).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/contracts/src/__tests__/envelope.unit.test.ts`
Expected: FAIL — `traceparent` is not a known property.

- [ ] **Step 3: Add the field**

In `packages/contracts/src/envelope.ts`, add to `EventEnvelopeSchema` after `producer`:

```ts
  // Optional by design: an event minted before Phase 7c carries none, and a required
  // field would retry-then-dead-letter every event in flight during the deploy.
  traceparent: z.string().optional(),
```

Add to `makeEnvelope`'s input type: `traceparent?: string;`

And to its returned object, after `producer: input.producer,`:

```ts
    ...(input.traceparent ? { traceparent: input.traceparent } : {}),
```

Spread-conditionally rather than assigning `undefined`, so an envelope without a
traceparent serializes to JSON with no key at all rather than an explicit null.

- [ ] **Step 4: Run and confirm green**

Run: `pnpm vitest run packages/contracts`
Expected: PASS, all pre-existing contracts tests unmodified.

- [ ] **Step 5: Typecheck, format, commit**

```bash
pnpm -r typecheck && pnpm format:check
git add packages/contracts/src/envelope.ts packages/contracts/src/__tests__/envelope.unit.test.ts
git commit -m "feat(contracts): optional traceparent on the event envelope"
```

---

### Task 2: The tracing bootstrap

**Files:**
- Create: `packages/shared/src/tracing.ts`
- Test: `packages/shared/src/__tests__/tracing.unit.test.ts`
- Modify: `packages/shared/package.json`

**Interfaces:**
- Produces: a side-effecting module suitable for `--import`, plus `export function tracingStarted(): boolean` for the test.

**Do NOT export this from `packages/shared/src/index.ts`.** It is a preload, not a library
import — exporting it would run SDK startup inside every service and every test that imports
anything from shared.

- [ ] **Step 1: Add dependencies**

```bash
pnpm --filter @ecom/shared add @opentelemetry/api @opentelemetry/sdk-node \
  @opentelemetry/exporter-trace-otlp-http @opentelemetry/instrumentation-http \
  @opentelemetry/instrumentation-express @opentelemetry/instrumentation-redis \
  @opentelemetry/resources @opentelemetry/semantic-conventions
pnpm --filter @ecom/shared add @prisma/instrumentation@^6.19
# Test-only: Tasks 6 and 7 assert on spans with an in-memory exporter, which lives here.
pnpm --filter @ecom/shared add -D @opentelemetry/sdk-trace-node
```

Verify `@prisma/instrumentation` resolved to a 6.x, not 7.x:
`grep -A1 '"@prisma/instrumentation"' packages/shared/package.json`

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";

describe("tracing bootstrap", () => {
  it("is idempotent — a second evaluation does not start a second SDK", async () => {
    const first = await import("../tracing");
    expect(first.tracingStarted()).toBe(true);

    // Re-evaluate the module with a cleared registry — this is what the tsx loader
    // does, and it is the case a module-local flag would fail to guard. Use
    // vi.resetModules(), NOT an `import("../tracing?query")` cache-buster: vitest
    // resolves that through its own transform pipeline and it does not reliably
    // produce a second evaluation.
    vi.resetModules();
    const second = await import("../tracing");
    expect(second.tracingStarted()).toBe(true);
    expect(globalThis.__ecomTracingStarted__).toBe(true);
  });

  it("enables exactly the intended instrumentations and no messaging ones", async () => {
    const { ENABLED_INSTRUMENTATIONS } = await import("../tracing");
    expect(ENABLED_INSTRUMENTATIONS).toEqual([
      "@opentelemetry/instrumentation-http",
      "@opentelemetry/instrumentation-express",
      "@opentelemetry/instrumentation-redis",
      "@prisma/instrumentation",
    ]);
    // The load-bearing assertion: these propagate via broker headers while this system
    // propagates via the envelope. Enabling both yields traces that are correct on sync
    // hops and quietly wrong on async ones.
    expect(ENABLED_INSTRUMENTATIONS).not.toContain("@opentelemetry/instrumentation-kafkajs");
    expect(ENABLED_INSTRUMENTATIONS).not.toContain("@opentelemetry/instrumentation-amqplib");
  });
});
```

- [ ] **Step 3: Run and confirm it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/tracing.unit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the module**

```ts
// Preload module, loaded via NODE_OPTIONS=--import. NOT exported from index.ts:
// importing it as a library would start the SDK inside every service and every test.
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { RedisInstrumentation } from "@opentelemetry/instrumentation-redis";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { createLogger } from "./logger";

const log = createLogger("tracing");

// The set is explicit, never getNodeAutoInstrumentations(): that bundle includes
// kafkajs and amqplib, which propagate through broker headers and would compete
// with this system's envelope-carried context. It also includes fs, which buries
// a trace in hundreds of spans.
export const ENABLED_INSTRUMENTATIONS = [
  "@opentelemetry/instrumentation-http",
  "@opentelemetry/instrumentation-express",
  "@opentelemetry/instrumentation-redis",
  "@prisma/instrumentation",
] as const;

declare global {
  // eslint-disable-next-line no-var
  var __ecomTracingStarted__: boolean | undefined;
}

// Must live on globalThis, NOT in a module-local variable. The tsx loader evaluates
// this module more than once, in SEPARATE module registries — a module-local flag is
// a fresh `false` each time and guards nothing, so the SDK would register duplicate
// exporters and duplicate instrumentations.
function start(): void {
  if (globalThis.__ecomTracingStarted__) return;
  globalThis.__ecomTracingStarted__ = true;

  try {
    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter(),
      instrumentations: [
        new HttpInstrumentation(),
        new ExpressInstrumentation(),
        new RedisInstrumentation(),
        new PrismaInstrumentation(),
      ],
    });
    sdk.start();
    process.once("SIGTERM", () => {
      void sdk.shutdown().catch(() => {
        /* shutdown telemetry must never delay or fail process exit */
      });
    });
    log.info("tracing_started", { service: process.env.OTEL_SERVICE_NAME ?? "unknown" });
  } catch (e) {
    // Global constraint 1: instrumentation must never take the process down.
    log.warn("tracing_start_failed", { message: (e as Error).message });
  }
}

export function tracingStarted(): boolean {
  return globalThis.__ecomTracingStarted__ === true;
}

start();
```

Service name, endpoint and sampler all come from the standard env vars
(`OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_SAMPLER`), which the
SDK reads itself — no bespoke config schema.

- [ ] **Step 5: Run and confirm green**

Run: `pnpm vitest run packages/shared/src/__tests__/tracing.unit.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Verify the preload actually preloads**

This is the mechanism the whole slice rests on, and three things about it were wrong on
first guess. Confirm it end to end before moving on:

```bash
cat > /tmp/7c-probe-main.ts <<'EOF'
console.log("MAIN SECOND");
EOF
NODE_OPTIONS="--import tsx --import file://$PWD/packages/shared/src/tracing.ts" \
  OTEL_SERVICE_NAME=probe npx tsx /tmp/7c-probe-main.ts
rm -f /tmp/7c-probe-main.ts
```

Expected: the `tracing_started` log line appears **before** `MAIN SECOND`, and appears
**once** even though the module is evaluated more than once. If it appears twice, the
`globalThis` guard is wrong — fix it before continuing.

- [ ] **Step 7: Typecheck, format, commit**

```bash
pnpm -r typecheck && pnpm format:check
git add packages/shared/src/tracing.ts packages/shared/src/__tests__/tracing.unit.test.ts \
        packages/shared/package.json pnpm-lock.yaml
git commit -m "feat(shared): idempotent OTel bootstrap with an explicit instrumentation set"
```

---

### Task 3: The HTTP seam — `traceId` becomes the W3C trace ID

**Files:**
- Modify: `packages/shared/src/trace.ts`
- Test: `packages/shared/src/__tests__/trace.test.ts` (exists — extend, do not rewrite)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `currentTraceparent(): string | undefined` — used by Tasks 5, 6 and 7.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/__tests__/trace.test.ts`:

```ts
import { context, trace, SpanContext, TraceFlags } from "@opentelemetry/api";
import { currentTraceparent } from "../trace";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

function withSpan<T>(fn: () => T): T {
  const sc: SpanContext = {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false,
  };
  const ctx = trace.setSpanContext(context.active(), sc);
  return context.with(ctx, fn);
}

describe("traceId derives from the active span", () => {
  it("uses the active span's trace id, not a fresh uuid", () => {
    const req = { header: () => undefined, method: "GET", path: "/x" } as never;
    const res = { setHeader: () => {} } as never;
    withSpan(() => traceMiddleware()(req, res, () => {}));
    expect((req as { traceId: string }).traceId).toBe(TRACE_ID);
  });

  it("falls back to a uuid when there is no active span (every test run)", () => {
    const req = { header: () => undefined, method: "GET", path: "/x" } as never;
    const res = { setHeader: () => {} } as never;
    traceMiddleware()(req, res, () => {});
    expect((req as { traceId: string }).traceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("currentTraceparent serializes the active span context", () => {
    expect(withSpan(() => currentTraceparent())).toBe(
      `00-${TRACE_ID}-${SPAN_ID}-01`
    );
  });

  it("currentTraceparent is undefined with no active span", () => {
    expect(currentTraceparent()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/trace.test.ts`
Expected: FAIL — `currentTraceparent` is not exported.

- [ ] **Step 3: Rewrite the middleware**

In `packages/shared/src/trace.ts`, add the import and replace the traceId derivation:

```ts
import { trace, context } from "@opentelemetry/api";
```

```ts
// The active span's trace id IS the traceId now, so a log line pastes straight into
// Jaeger. With no active span — every test run, and any service started without the
// NODE_OPTIONS preload — fall back to the old uuid so nothing that works today stops.
function activeTraceId(): string | undefined {
  const sc = trace.getSpanContext(context.active());
  return sc && sc.traceId !== "00000000000000000000000000000000" ? sc.traceId : undefined;
}

export function currentTraceparent(): string | undefined {
  const sc = trace.getSpanContext(context.active());
  if (!sc || sc.traceId === "00000000000000000000000000000000") return undefined;
  return `00-${sc.traceId}-${sc.spanId}-${sc.traceFlags.toString(16).padStart(2, "0")}`;
}
```

Then in `traceMiddleware`, replace the existing assignment:

```ts
    const incoming = req.header(TRACE_HEADER);
    // Precedence: the active span (established by the http instrumentation, which has
    // already extracted any inbound W3C `traceparent`) > the legacy x-trace-id header >
    // a fresh uuid. x-trace-id stays supported so external callers keep working.
    const traceId = activeTraceId() ?? (incoming && incoming.length > 0 ? incoming : uuidv4());
```

- [ ] **Step 4: Run and confirm green**

Run: `pnpm vitest run packages/shared/src/__tests__/trace.test.ts`
Expected: PASS — the pre-existing trace tests unmodified plus the 4 new ones.

- [ ] **Step 5: Typecheck, format, commit**

```bash
pnpm -r typecheck && pnpm format:check
git add packages/shared/src/trace.ts packages/shared/src/__tests__/trace.test.ts
git commit -m "feat(shared): traceId derives from the active span, x-trace-id kept as fallback"
```

---

### Task 4: Persist `traceparent` on the outbox row

**Files:**
- Modify: `packages/shared/src/outbox.ts`
- Modify: `services/{hello,inventory,order,payment,catalog,notification,identity}/prisma/schema.prisma`
- Test: `packages/shared/src/__tests__/outbox.unit.test.ts` (exists — extend)

**Interfaces:**
- Consumes: `currentTraceparent()` from Task 3; `EventEnvelope.traceparent` from Task 1.
- Produces: `OutboxRow.traceparent?: string | null`, carried into the relayed envelope.

Seven services own `model Outbox`; gateway has no database. Their `outbox-adapter.ts`
files all do `rows as unknown as OutboxRow[]`, so **no adapter needs editing** — the
column and the type are enough.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/__tests__/outbox.unit.test.ts`:

```ts
it("carries the row's traceparent into the relayed envelope", async () => {
  const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const published: EventEnvelope[] = [];
  const port: OutboxPort = {
    async fetchUnsent() {
      return [
        {
          id: "11111111-1111-4111-8111-111111111111",
          aggregateType: "order",
          aggregateId: "o1",
          type: "order.placed",
          version: 1,
          traceId: "t",
          traceparent: TP,
          producer: "order",
          payload: {},
          occurredAt: new Date(),
          sentAt: null,
        },
      ];
    },
    async markSent() {},
  };
  await drainOutbox(port, { async publish(_t, e) { published.push(e); } }, () => "order.events");
  expect(published[0].traceparent).toBe(TP);
});

it("relays a row with no traceparent (pre-7c rows) without throwing", async () => {
  const published: EventEnvelope[] = [];
  const port: OutboxPort = {
    async fetchUnsent() {
      return [
        {
          id: "22222222-2222-4222-8222-222222222222",
          aggregateType: "order",
          aggregateId: "o2",
          type: "order.placed",
          version: 1,
          traceId: "t",
          producer: "order",
          payload: {},
          occurredAt: new Date(),
          sentAt: null,
        },
      ];
    },
    async markSent() {},
  };
  await drainOutbox(port, { async publish(_t, e) { published.push(e); } }, () => "order.events");
  expect(published[0].traceparent).toBeUndefined();
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/outbox.unit.test.ts`
Expected: FAIL — `traceparent` is not a property of `OutboxRow`.

- [ ] **Step 3: Extend the type and the builder**

In `packages/shared/src/outbox.ts`, add to `OutboxRow` after `traceId: string;`:

```ts
  // Nullable: rows written before Phase 7c have none, and Prisma returns null not undefined.
  traceparent?: string | null;
```

And in `toEnvelope`, after `traceId: row.traceId,`:

```ts
    ...(row.traceparent ? { traceparent: row.traceparent } : {}),
```

- [ ] **Step 4: Run and confirm green**

Run: `pnpm vitest run packages/shared/src/__tests__/outbox.unit.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the column to all seven schemas**

In each of `services/{hello,inventory,order,payment,catalog,notification,identity}/prisma/schema.prisma`,
add to `model Outbox` after the `traceId` line:

```prisma
  traceparent   String?
```

Then generate one migration per service — **CLI only**, hand-writing the migration file is
blocked by a hook and breaks Prisma's checksums:

```bash
for s in hello inventory order payment catalog notification identity; do
  DATABASE_URL="postgresql://ecom:ecom@localhost:5432/$s" \
    pnpm --filter "@ecom/$s" exec prisma migrate dev --name add_traceparent_to_outbox
done
```

If port 5432 is taken by another local stack, use the remapped port instead — see the
Local infra note in Global Constraints.

- [ ] **Step 6: Run the full suite**

Run: `pnpm vitest run packages/shared`
Expected: PASS, all pre-existing shared tests unmodified.

- [ ] **Step 7: Typecheck, format, commit**

```bash
pnpm -r typecheck && pnpm format:check
git add packages/shared/src/outbox.ts packages/shared/src/__tests__/outbox.unit.test.ts \
        services/*/prisma/schema.prisma services/*/prisma/migrations
git commit -m "feat(shared,services): persist traceparent on the outbox row"
```

---

### Task 5: Capture `traceparent` at every outbox write site

**Files:**
- Modify, all enumerated and verified — 10 sites across 8 files:
  - `services/order/src/tx-adapters.ts` (2: inside `placeOrderTx` and `transitionTx`)
  - `services/inventory/src/tx-adapters.ts:42`, `:86`
  - `services/inventory/src/sweeper.ts:25`
  - `services/payment/src/tx-adapters.ts:31`, `:68`
  - `services/identity/src/tx-adapters.ts:51`
  - `services/catalog/src/tx-adapters.ts:42`
  - `services/notification/src/tx-adapters.ts:26`
  - `services/hello/src/app.ts:41`
- Test: `services/order/src/__tests__/outbox-traceparent.int.test.ts`

**Interfaces:**
- Consumes: `currentTraceparent()` from Task 3.

Find every site first — do not trust this list to be exhaustive:

```bash
grep -rn "outbox.create" services --include="*.ts" | grep -v __tests__ | grep -v generated
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterAll } from "vitest";
import { context, trace, TraceFlags, type SpanContext } from "@opentelemetry/api";
import { randomUUID } from "crypto";
import { prisma } from "../db";
import { placeOrderTx } from "../tx-adapters";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

describe("outbox rows capture the active traceparent (integration)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("writes the active span's context onto the row", async () => {
    const orderId = `o_${randomUUID()}`;
    const sc: SpanContext = {
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    };
    await context.with(trace.setSpanContext(context.active(), sc), async () => {
      await prisma.$transaction(async (tx) => {
        await placeOrderTx(tx, "t").enqueue("order.placed", orderId, {});
      });
    });
    const row = await prisma.outbox.findFirst({ where: { aggregateId: orderId } });
    expect(row?.traceparent).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
  });

  it("writes null when there is no active span, rather than throwing", async () => {
    const orderId = `o_${randomUUID()}`;
    await prisma.$transaction(async (tx) => {
      await placeOrderTx(tx, "t").enqueue("order.placed", orderId, {});
    });
    const row = await prisma.outbox.findFirst({ where: { aggregateId: orderId } });
    expect(row?.traceparent).toBeNull();
  });
});
```

Named `.int.test.ts` because it imports the service's `db` and therefore its config —
Global Constraint 7.

- [ ] **Step 2: Run and confirm it fails**

Run: `DATABASE_URL="postgresql://ecom:ecom@localhost:5432/order" pnpm vitest run services/order/src/__tests__/outbox-traceparent.int.test.ts`
Expected: FAIL — `row.traceparent` is null in the first case.

- [ ] **Step 3: Add the capture at each site**

At the top of each modified file:

```ts
import { currentTraceparent } from "@ecom/shared";
```

And inside every `tx.outbox.create({ data: { … } })`, after the existing `traceId,` line:

```ts
          traceparent: currentTraceparent(),
```

`currentTraceparent()` returns `undefined` with no active span and Prisma stores that as
`NULL` — so an untraced write (every unit test, any service started without the preload)
is unaffected. It cannot throw: it only reads the active context.

- [ ] **Step 4: Run and confirm green**

Run: `DATABASE_URL="postgresql://ecom:ecom@localhost:5432/order" pnpm vitest run services/order`
Expected: PASS, all pre-existing order tests unmodified.

- [ ] **Step 5: Confirm no write site was missed**

```bash
grep -rn "outbox.create" services --include="*.ts" | grep -v __tests__ | grep -v generated | \
  grep -L "traceparent" || echo "every site carries traceparent"
```

Re-read each hit and confirm it has the line. A missed site is a silently broken trace
chain for that one event type, which no test will catch.

- [ ] **Step 6: Typecheck, format, commit**

```bash
pnpm -r typecheck && pnpm format:check
git add services/*/src/tx-adapters.ts services/inventory/src/sweeper.ts services/hello/src/app.ts \
        services/order/src/__tests__/outbox-traceparent.int.test.ts
git commit -m "feat(services): capture the active traceparent on every outbox write"
```

---

### Task 6: Relay producer span + Kafka consumer span

**Files:**
- Modify: `packages/shared/src/outbox.ts`, `packages/shared/src/kafka.ts`
- Test: `packages/shared/src/__tests__/tracing-seams.unit.test.ts`

**Interfaces:**
- Consumes: `OutboxRow.traceparent` (Task 4), `EventEnvelope.traceparent` (Task 1).
- Produces: relayed envelopes whose `traceparent` is the **relay's** span, not the stored one.

This is the task that makes the relay's polling delay visible, and the one whose test must
discriminate — a counter-style test that only checks "a span exists" would pass against a
broken implementation.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { drainOutbox, type OutboxPort } from "../outbox";
import type { EventEnvelope } from "@ecom/contracts";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();

const STORED = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

beforeEach(() => exporter.reset());

function portWith(traceparent?: string): OutboxPort {
  return {
    async fetchUnsent() {
      return [
        {
          id: "33333333-3333-4333-8333-333333333333",
          aggregateType: "order",
          aggregateId: "o1",
          type: "order.placed",
          version: 1,
          traceId: "t",
          traceparent,
          producer: "order",
          payload: {},
          occurredAt: new Date(),
          sentAt: null,
        },
      ];
    },
    async markSent() {},
  };
}

describe("relay producer span", () => {
  it("parents to the STORED context and republishes its OWN context", async () => {
    const published: EventEnvelope[] = [];
    await drainOutbox(portWith(STORED), { async publish(_t, e) { published.push(e); } }, () => "order.events");

    const span = exporter.getFinishedSpans().find((s) => s.name.includes("order.events"));
    expect(span).toBeDefined();
    // Parented to the stored business span…
    expect(span!.spanContext().traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    // The parent-span-id accessor moved between SDK majors (`parentSpanId` in v1,
    // `parentSpanContext.spanId` in v2). Read whichever this version exposes rather than
    // pinning one and having the test fail for a reason that is not the behaviour.
    const parentSpanId =
      (span as unknown as { parentSpanContext?: { spanId: string }; parentSpanId?: string })
        .parentSpanContext?.spanId ??
      (span as unknown as { parentSpanId?: string }).parentSpanId;
    expect(parentSpanId).toBe("00f067aa0ba902b7");
    // …but the PUBLISHED envelope carries the relay's own span, not the stored one.
    // This is what lets the consumer parent to the relay and makes the poll gap visible.
    expect(published[0].traceparent).not.toBe(STORED);
    expect(published[0].traceparent).toContain(span!.spanContext().spanId);
  });

  it("starts a fresh trace when the stored traceparent is malformed, and does not throw", async () => {
    const published: EventEnvelope[] = [];
    await expect(
      drainOutbox(portWith("not-a-traceparent"), { async publish(_t, e) { published.push(e); } }, () => "order.events")
    ).resolves.toBeDefined();
    expect(published).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/tracing-seams.unit.test.ts`
Expected: FAIL — no span is produced.

- [ ] **Step 3: Add the producer span to the relay**

In `packages/shared/src/outbox.ts`:

```ts
import { trace, context, propagation, SpanKind } from "@opentelemetry/api";

const tracer = trace.getTracer("@ecom/shared/outbox");

// Rebuild a context from the stored traceparent. Never throws: a malformed value from an
// older or untrusted producer yields the active context, which starts a fresh trace.
function contextFromRow(row: OutboxRow) {
  try {
    return row.traceparent
      ? propagation.extract(context.active(), { traceparent: row.traceparent })
      : context.active();
  } catch {
    return context.active();
  }
}
```

Then wrap the publish. Where `drainOutbox` currently does `await producer.publish(topic, envelope)`,
replace with:

```ts
      const parent = contextFromRow(row);
      await context.with(parent, async () => {
        const span = tracer.startSpan(`${topic} publish`, { kind: SpanKind.PRODUCER });
        try {
          // Overwrite the OUTGOING envelope's traceparent with this span's context, so the
          // consumer parents to the relay and the poll delay is visible as the gap between
          // the business span ending and this one starting. The stored row is untouched —
          // a replayed row still re-parents to the original business operation.
          const carrier: Record<string, string> = {};
          propagation.inject(trace.setSpan(context.active(), span), carrier);
          const outgoing = carrier.traceparent
            ? { ...envelope, traceparent: carrier.traceparent }
            : envelope;
          await producer.publish(topic, outgoing);
        } finally {
          span.end();
        }
      });
```

Apply the same shape to the command lane (`sender.sendCommand`), so the RabbitMQ leg —
which is how the checkout reaches **payment** — is covered too. That leg is the one most
easily missed, because the Kafka path is the one usually drawn.

- [ ] **Step 4: Add the consumer span in kafka.ts**

In `packages/shared/src/kafka.ts`, inside `eachMessage`, after the envelope parses and
**around** the existing `withRetry(() => handler(env), …)` call:

```ts
            const parent = (() => {
              try {
                return env.traceparent
                  ? propagation.extract(context.active(), { traceparent: env.traceparent })
                  : context.active();
              } catch {
                return context.active();
              }
            })();
            await context.with(parent, async () => {
              const span = tracer.startSpan(`${topic} process`, { kind: SpanKind.CONSUMER });
              span.setAttribute("messaging.message.id", env.eventId);
              span.setAttribute("messaging.destination.name", topic);
              try {
                await withRetry(() => handler(env), { retries: maxRetries, baseMs: 200 });
              } finally {
                span.end();
              }
            });
```

Attributes are IDs only — never the payload (Global Constraint 9).

Leave the existing metrics hooks and the DLQ catch **exactly** as they are. The span must
never change whether a message is parked: it wraps only the handler call, inside the
existing try.

- [ ] **Step 5: Run and confirm green**

Run: `pnpm vitest run packages/shared`
Expected: PASS — new seam tests plus every pre-existing shared test unmodified, including
`kafka-hooks.unit.test.ts` and both kafka integration suites.

- [ ] **Step 6: Prove the consumer seam discriminates**

Delete the `propagation.extract` line in `kafka.ts` (make it always `context.active()`),
re-run, and confirm a test fails. Restore. Record which test failed in the task report —
a seam test that passes with the wiring removed is worthless, and this slice has three of them.

- [ ] **Step 7: Typecheck, format, commit**

```bash
pnpm -r typecheck && pnpm format:check
git add packages/shared/src/outbox.ts packages/shared/src/kafka.ts \
        packages/shared/src/__tests__/tracing-seams.unit.test.ts
git commit -m "feat(shared): relay producer spans and kafka consumer spans"
```

---

### Task 7: RabbitMQ command seam

**Files:**
- Modify: `packages/shared/src/rabbitmq.ts`
- Test: `packages/shared/src/__tests__/tracing-rabbit.unit.test.ts`

**Interfaces:**
- Consumes: `EventEnvelope.traceparent` (Task 1).

`sendCommand` (`rabbitmq.ts:77`) and `consumeCommands` (`:88`) carry the
`ChargePayment` leg — gateway → order → **payment**. Without this task the Done-when
cannot be met, however good the Kafka path is.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { makeEnvelope } from "@ecom/contracts";
import { consumerContextFor } from "../rabbitmq";

const exporter = new InMemorySpanExporter();
new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).register();

const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

beforeEach(() => exporter.reset());

describe("rabbit consumer context", () => {
  it("extracts the envelope's traceparent as the parent", () => {
    const env = makeEnvelope({
      type: "payment.charge", version: 1, traceId: "t",
      producer: "order", payload: {}, traceparent: TP,
    });
    const ctx = consumerContextFor(env);
    const { trace, context } = require("@opentelemetry/api");
    expect(trace.getSpanContext(ctx)!.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("returns the active context — not a throw — for a malformed traceparent", () => {
    const env = makeEnvelope({
      type: "payment.charge", version: 1, traceId: "t",
      producer: "order", payload: {}, traceparent: "garbage",
    });
    expect(() => consumerContextFor(env)).not.toThrow();
  });

  it("returns the active context when there is no traceparent at all", () => {
    const env = makeEnvelope({
      type: "payment.charge", version: 1, traceId: "t", producer: "order", payload: {},
    });
    expect(() => consumerContextFor(env)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/tracing-rabbit.unit.test.ts`
Expected: FAIL — `consumerContextFor` is not exported.

- [ ] **Step 3: Implement**

In `packages/shared/src/rabbitmq.ts`:

```ts
import { trace, context, propagation, SpanKind } from "@opentelemetry/api";

const tracer = trace.getTracer("@ecom/shared/rabbitmq");

// Exported for the unit test: the extraction is the part that can silently regress.
export function consumerContextFor(env: EventEnvelope) {
  try {
    return env.traceparent
      ? propagation.extract(context.active(), { traceparent: env.traceparent })
      : context.active();
  } catch {
    return context.active();
  }
}
```

Wrap the handler call inside `consumeCommands` the same way Task 6 wrapped the Kafka
handler — a `${queue} process` span of kind `CONSUMER`, started inside
`context.with(consumerContextFor(env), …)`, ended in a `finally`, with the existing retry
and DLQ behaviour untouched.

`sendCommand` already receives an envelope whose `traceparent` the relay set in Task 6, so
it needs no change beyond a `${queue} send` PRODUCER span if one is wanted; the parenting
is already correct without it.

- [ ] **Step 4: Run and confirm green**

Run: `pnpm vitest run packages/shared`
Expected: PASS, including `rabbitmq.int.test.ts` unmodified.

- [ ] **Step 5: Typecheck, format, commit**

```bash
pnpm -r typecheck && pnpm format:check
git add packages/shared/src/rabbitmq.ts packages/shared/src/__tests__/tracing-rabbit.unit.test.ts
git commit -m "feat(shared): rabbit consumer spans parented to the envelope context"
```

---

### Task 8: Jaeger in compose, preload wiring, docs

**Files:**
- Modify: `docker-compose.example.yml`, `docker-compose.prod.example.yml`, `docs/infra.md`

**Interfaces:**
- Consumes: `packages/shared/src/tracing.ts` (Task 2).

- [ ] **Step 1: Check the UI port is free**

```bash
docker ps --format "{{.Names}}\t{{.Ports}}" | grep -E "16686" || echo "16686 free"
```

This machine's unrelated `eda-platform` stack already collides on 5432, 9090, 4318 and
1025/8025. If 16686 is taken, use a host remap and note it — do not stop the other stack.

- [ ] **Step 2: Add Jaeger**

In `docker-compose.example.yml`, beside the `prometheus` and `grafana` entries added in 7b:

```yaml
  jaeger:
    image: jaegertracing/all-in-one:1.62.0
    restart: unless-stopped
    ports: ["16686:16686"]   # UI only — OTLP stays in-network, like the gateway's metrics port
    environment:
      COLLECTOR_OTLP_ENABLED: "true"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:14269/"]
      interval: 10s
      timeout: 5s
      retries: 10
```

Ports 4317/4318 are deliberately **not** published: services reach `jaeger:4318` over the
compose network, so nothing on the host can post spans.

- [ ] **Step 3: Wire the preload into all 8 services**

To each service's `environment:` block in `docker-compose.example.yml`:

```yaml
      OTEL_SERVICE_NAME: <service-name>
      OTEL_EXPORTER_OTLP_ENDPOINT: http://jaeger:4318
      NODE_OPTIONS: --import tsx --import file:///repo/packages/shared/src/tracing.ts
```

The `file://` URL and the `--import tsx` ordering are both load-bearing and were verified
by experiment — a bare specifier fails with `ERR_MODULE_NOT_FOUND` because
`@ecom/shared` has no `exports` map, and the bootstrap is a `.ts` file so tsx's loader must
be registered first. `/repo/packages/shared/src/tracing.ts` is correct in all 8 containers:
every Dockerfile does `WORKDIR /repo` → `COPY packages ./packages`.

- [ ] **Step 4: Prod overlay**

In `docker-compose.prod.example.yml`, beside the prometheus and grafana entries:

```yaml
  jaeger:
    ports: !reset []
```

A bare `[]` silently merges and does nothing — `!reset` is required.

- [ ] **Step 5: Document**

In `docs/infra.md`, add to the endpoint table:

```
| Jaeger     | http://localhost:16686  | traces; needs `--profile app` |
```

Plus a short paragraph: traces are exported to `jaeger:4318` in-network and the OTLP ports
are unpublished; a `traceId` from any log line is the Jaeger search term.

- [ ] **Step 6: Validate**

```bash
docker compose -f docker-compose.example.yml config >/dev/null && echo "compose valid"
docker compose -f docker-compose.example.yml -f docker-compose.prod.example.yml --profile app config \
  | python3 -c "import sys,yaml; c=yaml.safe_load(sys.stdin); print('jaeger prod ports:', c['services']['jaeger'].get('ports','(none)'))"
```

Expected: valid, and jaeger's prod ports resolve to none.

- [ ] **Step 7: Commit**

```bash
pnpm format:check
git add docker-compose.example.yml docker-compose.prod.example.yml docs/infra.md
git commit -m "feat(infra): jaeger all-in-one and the tracing preload wiring"
```

---

### Task 9: End-to-end acceptance

**Files:**
- Create: `.superpowers/sdd/2026-07-29-phase-7c-tracing/acceptance.md` (evidence, not code)

**Interfaces:**
- Consumes: every prior task.

The spec's Done-when is the acceptance test. 7b proved this step earns its keep: running it
found a dashboard panel that rendered "No data" for every healthy service, which no amount
of static review had caught.

- [ ] **Step 1: Bring the stack up**

```bash
bash infra/scripts/reset-dev-topics.sh
docker compose --profile app up -d --build
docker compose ps    # every service healthy
```

- [ ] **Step 2: Confirm spans are arriving**

Open `http://localhost:16686` and confirm the service dropdown lists the traced services.

- [ ] **Step 3: Drive a real checkout**

Through the gateway on :8000 — register → login → add to cart → place order. Three details
that cost time in 7b: register requires a `name` field, every mutation needs the
double-submit CSRF header (echo the `XSRF-TOKEN` cookie into `x-csrf-token`), and the cart is
its own gateway mount (`/cart`, not `/orders/cart`). Inventory needs a stock row for the
product, and `Inventory.updatedAt` is NOT NULL with no default.

- [ ] **Step 4: Verify the Done-when**

In Jaeger, find the trace and confirm **all** of:

- One trace spans gateway → order → inventory → payment → notification.
- The **payment** hop is present — it travels over RabbitMQ, so its absence means Task 7 is
  not wired even if everything else looks right.
- A gap is visible between a business span ending and the next `publish` span starting —
  that is the relay poll delay, and its visibility is the point of the whole design.
- The `traceId` from the order service's log line for that order finds this exact trace.

- [ ] **Step 5: Measure the idle span floor**

With the stack up and no traffic, note the span rate over one minute. Seven relays poll
every 500ms and the DLQ poller every 15s, so there is a standing floor independent of
requests. Record the number — 7d needs it to choose a sampling ratio, and it is far cheaper
to measure now than under k6 load.

- [ ] **Step 6: Record the evidence**

Write `acceptance.md` with: the trace screenshot or span list, the measured idle span rate,
which services appeared, and anything that did not work. Note explicitly that `hello`'s
container CrashLoops on a pre-existing corepack issue (`services/hello/Dockerfile` is
untouched by 7b and 7c), so its spans cannot be verified in-container — the same limitation
its Prometheus target has.

- [ ] **Step 7: Full regression**

```bash
pnpm -r typecheck && pnpm format:check
# per-service, because each has its own database — a single DATABASE_URL cannot work
for s in hello inventory order payment catalog notification identity gateway; do
  DATABASE_URL="postgresql://ecom:ecom@localhost:5432/$s" pnpm vitest run "services/$s"
done
pnpm vitest run packages
```

Expected: all 356 pre-existing tests pass **unmodified**, plus the new ones.

- [ ] **Step 8: Commit**

```bash
git add .superpowers/sdd/2026-07-29-phase-7c-tracing/acceptance.md
git commit -m "docs(7c): end-to-end tracing acceptance evidence"
```

---

## Notes for the executor

**Task order is dependency order.** 1 → 2 → 3 must be sequential (contract, then bootstrap,
then `currentTraceparent`). 4 and 5 both depend on 3. 6 and 7 both depend on 4. 8 depends on
2. 9 depends on everything.

**The three discriminating tests** are Task 5 Step 5, Task 6 Step 6, and Task 9 Step 4. Each
exists because the corresponding naive test would pass against a broken implementation. If
one of them cannot be made to fail by removing the wiring it is meant to protect, say so in
the task report rather than moving on — that is a finding, not a formality.

**When a task's brief and the Global Constraints disagree, the constraints win.** Both 7a
and 7b had a plan snippet that omitted a try/catch the constraints already required, and
both were adjudicated the same way.
