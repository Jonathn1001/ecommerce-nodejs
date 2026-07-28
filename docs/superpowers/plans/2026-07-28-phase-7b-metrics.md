# Phase 7b — Metrics & dashboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Prometheus metrics on all eight services — HTTP RED plus six domain metrics — and ship one provisioned Grafana dashboard that shows a full checkout end to end.

**Architecture:** A single new module `packages/shared/src/metrics.ts` owns everything generic: an explicit per-service `prom-client` Registry, RED middleware, the `GET /metrics` router, Kafka instrumentation hooks, and a DLQ-depth poller driven by an injected probe function. Services adopt it with the same two-line shape they already use for `traceMiddleware` and `createHealthRouter`, and register their own domain metrics against the injected registry. Prometheus and Grafana join compose with their config committed under `infra/`.

**Tech Stack:** TypeScript, Express 4, `prom-client` (new), kafkajs, amqplib, vitest + supertest, Prometheus, Grafana, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-07-28-phase-7b-metrics-design.md`

## Global Constraints

- **No business-logic change.** This slice is instrumentation only. Every pre-existing test must pass **unmodified**. If a test needs editing to accommodate metrics, the metrics design is wrong — stop and report it.
- **`prom-client` is a dependency of `packages/shared` only.** No service adds it directly.
- **The `route` label is a bounded route pattern, never a raw path.** Unmatched requests label `route="unmatched"`. This is the cardinality bomb; it gets a direct test.
- **`collectDefaultMetrics` is opt-in** via `createMetrics(name, { defaultMetrics: true })` and is enabled **only from `main.ts`**. It starts an interval with no stop handle; enabling it by default leaks one collector per test file and hangs vitest.
- **The metrics parameter on `createApp` is optional in every service**, defaulting to a fresh `createMetrics("<service>")`. This is what keeps existing `createApp()` calls compiling untouched.
- **Nothing in this slice may throw into a production path.** Metric recording, the Kafka instrumentation listener and the DLQ poller each swallow and log their own errors.
- **`/metrics` handlers are `async`** (`registry.metrics()` returns a promise) and **must** be try/caught — unguarded async Express 4 routes crash the process, the exact class that made Phase 4 a DON'T-MERGE.
- **CI is untouched.** Metrics tests run against the registry object in-process; nothing scrapes.
  No new job, no Prometheus container in CI, and no change to the per-service test loop 7a built —
  the new tests run inside the existing arms. If you find yourself editing `.github/workflows/`, stop.
- Commit per task with the file list spelled out. Never `git add -A`.
- Every task ends green: `pnpm -r typecheck` and `pnpm format:check` clean.

---

## File Structure

**Created:**
- `packages/shared/src/metrics.ts` — the shared module (registry, RED middleware, router, Kafka hooks, DLQ poller)
- `packages/shared/src/__tests__/metrics.unit.test.ts`
- `packages/shared/src/__tests__/metrics-kafka.unit.test.ts`
- `packages/shared/src/__tests__/metrics-dlq.unit.test.ts`
- `services/order/src/metrics.ts`, `services/inventory/src/metrics.ts`, `services/payment/src/metrics.ts`, `services/notification/src/metrics.ts` — domain metrics
- `infra/prometheus/prometheus.yml`
- `infra/grafana/provisioning/datasources/prometheus.yml`
- `infra/grafana/provisioning/dashboards/dashboards.yml`
- `infra/grafana/dashboards/checkout.json`

**Modified:**
- `packages/shared/package.json` — `prom-client` dependency
- `packages/shared/src/index.ts` — export `./metrics`
- `packages/shared/src/kafka.ts` — optional `hooks` parameter on `createConsumer`
- `packages/shared/src/rabbitmq.ts` — new `queueDepth(queue)` method
- `services/*/src/app.ts` (×8) — optional `metrics` dep + two `app.use` lines
- `services/*/src/main.ts` (×8) — construct metrics, wire hooks/poller, pass to `createApp`
- `services/order/src/consumer.ts`, `services/inventory/src/consumer.ts` — domain recording at existing seams
- `services/gateway/src/config.ts`, `services/gateway/.env.example` — `METRICS_PORT`
- `docker-compose.example.yml`, `docker-compose.prod.example.yml`, `.env.example`, `docs/infra.md`
- `docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md` — Phase 7 prose (§F)

---

### Task 1: Shared metrics module — registry, RED middleware, `/metrics` router

**Files:**
- Create: `packages/shared/src/metrics.ts`
- Create: `packages/shared/src/__tests__/metrics.unit.test.ts`
- Create: `packages/shared/src/__tests__/metrics-kafka.unit.test.ts`
- Create: `packages/shared/src/__tests__/metrics-dlq.unit.test.ts`
- Modify: `packages/shared/package.json`
- Modify: `packages/shared/src/index.ts`

This task implements the metric objects, the `kafkaHooks` recorders and the DLQ poller, so the
tests covering all three live here. Tasks 2 and 3 test their own deliverables — the kafkajs
listener wiring and `queueDepth` — not these.

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type DlqProbe = (queue: string) => Promise<number>;
  export interface KafkaMetricsHooks {
    onBatch(p: { group: string; topic: string; partition: string; lag: number }): void;
    onMessage(p: { group: string; topic: string; result: "ok" | "dlq" }): void;
    observeHandler(p: { group: string; topic: string; type: string; seconds: number }): void;
  }
  export interface Metrics {
    registry: Registry;
    httpMiddleware(): RequestHandler;
    router(): Router;
    kafkaHooks: KafkaMetricsHooks;
    startDlqPoller(probe: DlqProbe, queues: string[], opts?: { intervalMs?: number }): { stop(): void };
  }
  export function createMetrics(serviceName: string, opts?: { defaultMetrics?: boolean }): Metrics;
  ```

**Route resolution — read this before writing the middleware.** The label is computed inside
`res.on("finish")`. Express restores `req.baseUrl` only when a handler calls `next()`; a handler
that terminates the response never triggers the restore, so `req.baseUrl` and `req.route` are
both still populated when `finish` fires. Precedence:

1. `res.locals.metricsRoute` if set (the gateway's proxy mounts set it — Task 6).
2. `req.route` present → `` `${req.baseUrl}${req.route.path}` `` — the `baseUrl` prefix is
   mandatory, because a router mounted at `/orders` with a handler registered as `/:id`
   reports `req.route.path === "/:id"` alone.
3. `req.baseUrl` non-empty → `req.baseUrl` (mounted middleware answered without a route).
4. Otherwise `"unmatched"`.

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @ecom/shared add prom-client
```

Expected: `packages/shared/package.json` gains `prom-client` under `dependencies`.

- [ ] **Step 2: Write the failing test**

Create `packages/shared/src/__tests__/metrics.unit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createMetrics } from "../metrics";

describe("createMetrics", () => {
  it("stamps the service default label on every sample", async () => {
    const m = createMetrics("order");
    const app = express().use(m.httpMiddleware()).use(m.router());
    app.get("/ping", (_req, res) => res.json({ ok: true }));

    await request(app).get("/ping");
    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain('service="order"');
  });

  it("labels a mounted router by its FULL pattern, not the mount-relative one", async () => {
    const m = createMetrics("order");
    const router = express.Router();
    router.get("/:id", (_req, res) => res.json({ ok: true }));

    const app = express().use(m.httpMiddleware());
    app.use("/orders", router);
    app.use(m.router());

    await request(app).get("/orders/abc-123");
    const res = await request(app).get("/metrics");

    expect(res.text).toContain('route="/orders/:id"');
    expect(res.text).not.toContain('route="/:id"');
    expect(res.text).not.toContain("abc-123");
  });

  it("labels unmatched requests as unmatched, never the raw path", async () => {
    const m = createMetrics("order");
    const app = express().use(m.httpMiddleware()).use(m.router());

    await request(app).get("/nope/deadbeef");
    const res = await request(app).get("/metrics");

    expect(res.text).toContain('route="unmatched"');
    expect(res.text).not.toContain("deadbeef");
  });

  it("does not start a default-metrics collector unless asked", async () => {
    const m = createMetrics("order");
    const res = await m.registry.metrics();
    expect(res).not.toContain("process_cpu_seconds_total");
  });

  it("collects default metrics when opted in", async () => {
    const m = createMetrics("order", { defaultMetrics: true });
    const res = await m.registry.metrics();
    expect(res).toContain("process_cpu_seconds_total");
  });
});
```

Also create `packages/shared/src/__tests__/metrics-kafka.unit.test.ts` — this covers the
**recorders** this task implements; Task 2 covers the kafkajs wiring that calls them:

```ts
import { describe, it, expect } from "vitest";
import { createMetrics } from "../metrics";

describe("kafka metric recorders", () => {
  it("records lag, outcomes and handler duration on the registry", async () => {
    const m = createMetrics("order");

    m.kafkaHooks.onBatch({ group: "g1", topic: "order.events", partition: "0", lag: 42 });
    m.kafkaHooks.onMessage({ group: "g1", topic: "order.events", result: "ok" });
    m.kafkaHooks.onMessage({ group: "g1", topic: "order.events", result: "dlq" });
    m.kafkaHooks.observeHandler({
      group: "g1",
      topic: "order.events",
      type: "order_placed",
      seconds: 0.2,
    });

    const out = await m.registry.metrics();
    // Label-order-independent: registry.setDefaultLabels appends service= to every
    // sample, so never pin the closing brace of a sample line.
    expect(out).toMatch(/kafka_consumer_lag\{[^}]*partition="0"[^}]*\} 42/);
    expect(out).toContain('result="dlq"');
    expect(out).toContain("kafka_handler_duration_seconds_bucket");
  });
});
```

And `packages/shared/src/__tests__/metrics-dlq.unit.test.ts` for the poller:

```ts
import { describe, it, expect, vi } from "vitest";
import { createMetrics } from "../metrics";

describe("startDlqPoller", () => {
  it("sets the gauge from the probe", async () => {
    const m = createMetrics("payment");
    const poller = m.startDlqPoller(async () => 7, ["payment.charge.dlq"], { intervalMs: 5 });

    await vi.waitFor(async () =>
      expect(await m.registry.metrics()).toMatch(
        /rabbitmq_dlq_depth\{[^}]*queue="payment\.charge\.dlq"[^}]*\} 7/
      )
    );
    poller.stop();
  });

  it("survives a rejecting probe and keeps polling", async () => {
    const m = createMetrics("payment");
    let calls = 0;
    const probe = async () => {
      calls += 1;
      if (calls < 3) throw new Error("channel closed");
      return 2;
    };
    const poller = m.startDlqPoller(probe, ["payment.charge.dlq"], { intervalMs: 5 });

    await vi.waitFor(async () =>
      expect(await m.registry.metrics()).toMatch(
        /rabbitmq_dlq_depth\{[^}]*queue="payment\.charge\.dlq"[^}]*\} 2/
      )
    );
    poller.stop();
  });

  it("stop() halts further probing", async () => {
    const m = createMetrics("payment");
    let calls = 0;
    const poller = m.startDlqPoller(
      async () => {
        calls += 1;
        return 1;
      },
      ["q.dlq"],
      { intervalMs: 5 }
    );

    await vi.waitFor(() => expect(calls).toBeGreaterThan(0));
    poller.stop();
    const seen = calls;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(seen);
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `pnpm vitest run packages/shared/src/__tests__/metrics.unit.test.ts packages/shared/src/__tests__/metrics-kafka.unit.test.ts packages/shared/src/__tests__/metrics-dlq.unit.test.ts`
Expected: all three FAIL — `Failed to resolve import "../metrics"`.

- [ ] **Step 4: Write the module**

Create `packages/shared/src/metrics.ts`:

```ts
import { Router, type Request, type RequestHandler } from "express";
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";
import { createLogger } from "./logger";

const log = createLogger("metrics");

export type DlqProbe = (queue: string) => Promise<number>;

export interface KafkaMetricsHooks {
  onBatch(p: { group: string; topic: string; partition: string; lag: number }): void;
  onMessage(p: { group: string; topic: string; result: "ok" | "dlq" }): void;
  observeHandler(p: { group: string; topic: string; type: string; seconds: number }): void;
}

export interface Metrics {
  registry: Registry;
  httpMiddleware(): RequestHandler;
  router(): Router;
  kafkaHooks: KafkaMetricsHooks;
  startDlqPoller(
    probe: DlqProbe,
    queues: string[],
    opts?: { intervalMs?: number }
  ): { stop(): void };
}

// Straddles the p95 < 500ms SLO so the quantile interpolates from real bucket edges.
const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

// `upstream` is "" everywhere except the gateway, where proxy mounts name their target.
// A constant empty label costs no cardinality and keeps one middleware for all services.
const HTTP_LABELS = ["method", "route", "status", "upstream"] as const;

export function resolveRoute(req: Request, metricsRoute?: string): string {
  if (metricsRoute) return metricsRoute;
  // Express restores baseUrl only when a handler calls next(); handlers that end the
  // response never trigger the restore, so both fields are still set at `finish` time.
  if (req.route) return `${req.baseUrl}${req.route.path}`;
  if (req.baseUrl) return req.baseUrl;
  return "unmatched";
}

export function createMetrics(
  serviceName: string,
  opts: { defaultMetrics?: boolean } = {}
): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: serviceName });

  // Off by default: collectDefaultMetrics starts an interval with no per-registry stop
  // handle, so calling it from every createApp() in every test file leaks collectors and
  // hangs vitest on open handles. Only main.ts opts in.
  if (opts.defaultMetrics) collectDefaultMetrics({ register: registry });

  const httpRequests = new Counter({
    name: "http_requests_total",
    help: "HTTP requests handled",
    labelNames: HTTP_LABELS,
    registers: [registry],
  });
  const httpDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: HTTP_LABELS,
    buckets: HTTP_BUCKETS,
    registers: [registry],
  });
  const kafkaLag = new Gauge({
    name: "kafka_consumer_lag",
    help: "Offset lag for partitions this consumer owns",
    labelNames: ["group", "topic", "partition"],
    registers: [registry],
  });
  const kafkaMessages = new Counter({
    name: "kafka_messages_total",
    help: "Kafka messages consumed by outcome",
    labelNames: ["group", "topic", "result"],
    registers: [registry],
  });
  const kafkaHandler = new Histogram({
    name: "kafka_handler_duration_seconds",
    help: "Consumer handler duration in seconds",
    labelNames: ["group", "topic", "type"],
    buckets: HTTP_BUCKETS,
    registers: [registry],
  });
  const dlqDepth = new Gauge({
    name: "rabbitmq_dlq_depth",
    help: "Messages sitting in a dead-letter queue",
    labelNames: ["queue"],
    registers: [registry],
  });

  function httpMiddleware(): RequestHandler {
    return (req, res, next) => {
      const start = process.hrtime.bigint();
      res.on("finish", () => {
        try {
          const labels = {
            method: req.method,
            route: resolveRoute(req, res.locals.metricsRoute as string | undefined),
            status: String(res.statusCode),
            upstream: (res.locals.metricsUpstream as string | undefined) ?? "",
          };
          httpRequests.inc(labels);
          httpDuration.observe(labels, Number(process.hrtime.bigint() - start) / 1e9);
        } catch (e) {
          log.error("metrics_http_record_failed", { message: (e as Error).message });
        }
      });
      next();
    };
  }

  function router(): Router {
    const r = Router();
    // registry.metrics() is async — an unguarded rejection here crashes the process.
    r.get("/metrics", async (_req, res) => {
      try {
        res.setHeader("Content-Type", registry.contentType);
        res.send(await registry.metrics());
      } catch (e) {
        log.error("metrics_scrape_failed", { message: (e as Error).message });
        res.status(500).send("");
      }
    });
    return r;
  }

  const kafkaHooks: KafkaMetricsHooks = {
    onBatch: ({ group, topic, partition, lag }) => kafkaLag.set({ group, topic, partition }, lag),
    onMessage: ({ group, topic, result }) => kafkaMessages.inc({ group, topic, result }),
    observeHandler: ({ group, topic, type, seconds }) =>
      kafkaHandler.observe({ group, topic, type }, seconds),
  };

  function startDlqPoller(probe: DlqProbe, queues: string[], o: { intervalMs?: number } = {}) {
    const intervalMs = o.intervalMs ?? 15_000;
    const tick = async () => {
      for (const q of queues) {
        try {
          dlqDepth.set({ queue: q }, await probe(q));
        } catch (e) {
          // Leave the gauge at its last value and keep polling — a metric must never
          // take the process down, and a stale gauge is better than a dead poller.
          log.error("dlq_probe_failed", { queue: q, message: (e as Error).message });
        }
      }
    };
    const handle = setInterval(() => void tick(), intervalMs);
    return { stop: () => clearInterval(handle) };
  }

  return { registry, httpMiddleware, router, kafkaHooks, startDlqPoller };
}
```

- [ ] **Step 5: Export it**

Add to `packages/shared/src/index.ts`, after the `./health` line:

```ts
export * from "./metrics";
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run packages/shared/src/__tests__/metrics.unit.test.ts packages/shared/src/__tests__/metrics-kafka.unit.test.ts packages/shared/src/__tests__/metrics-dlq.unit.test.ts`
Expected: PASS — 5 + 1 + 3 = 9 tests.

- [ ] **Step 7: Typecheck and format**

Run: `pnpm -r typecheck && pnpm format:check`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/metrics.ts \
        packages/shared/src/__tests__/metrics.unit.test.ts \
        packages/shared/src/__tests__/metrics-kafka.unit.test.ts \
        packages/shared/src/__tests__/metrics-dlq.unit.test.ts \
        packages/shared/src/index.ts \
        packages/shared/package.json \
        pnpm-lock.yaml
git commit -m "feat(shared): prom-client metrics module with RED middleware and /metrics"
```

---

### Task 2: Kafka instrumentation hooks

**Files:**
- Modify: `packages/shared/src/kafka.ts`
- Create: `packages/shared/src/__tests__/kafka-hooks.unit.test.ts`

**Interfaces:**
- Consumes: `KafkaMetricsHooks`, `createMetrics` from Task 1.
- Produces: `createConsumer(kafka, groupId, hooks?: KafkaMetricsHooks)` — third parameter is optional, so all existing call sites keep compiling.

Task 1 already tested the recorders. This task's deliverable is the **wiring**: that
`createConsumer` registers a kafkajs `END_BATCH_PROCESS` listener and maps its payload onto
`onBatch`. That is what the test below asserts, and it genuinely fails before Step 3.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/__tests__/kafka-hooks.unit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Kafka } from "kafkajs";
import { createConsumer } from "../kafka";
import type { KafkaMetricsHooks } from "../metrics";

const END_BATCH = "consumer.end_batch_process";

function fakeKafka() {
  const listeners: Record<string, (e: unknown) => void> = {};
  const consumer = {
    events: { END_BATCH_PROCESS: END_BATCH },
    on: (event: string, cb: (e: unknown) => void) => {
      listeners[event] = cb;
    },
    connect: async () => {},
    disconnect: async () => {},
    subscribe: async () => {},
    run: async () => {},
  };
  const producer = { connect: async () => {}, disconnect: async () => {} };
  const kafka = { consumer: () => consumer, producer: () => producer } as unknown as Kafka;
  return { kafka, listeners };
}

describe("createConsumer metrics wiring", () => {
  it("registers an END_BATCH_PROCESS listener and maps its payload onto onBatch", () => {
    const { kafka, listeners } = fakeKafka();
    const seen: unknown[] = [];
    const hooks: KafkaMetricsHooks = {
      onBatch: (p) => seen.push(p),
      onMessage: () => {},
      observeHandler: () => {},
    };

    createConsumer(kafka, "order-consumers", hooks);
    expect(listeners[END_BATCH]).toBeTypeOf("function");

    listeners[END_BATCH]({ payload: { topic: "order.events", partition: 2, offsetLag: "17" } });
    expect(seen).toEqual([
      { group: "order-consumers", topic: "order.events", partition: "2", lag: 17 },
    ]);
  });

  it("registers no listener when no hooks are passed", () => {
    const { kafka, listeners } = fakeKafka();
    createConsumer(kafka, "order-consumers");
    expect(listeners[END_BATCH]).toBeUndefined();
  });

  it("does not propagate a throwing hook", () => {
    const { kafka, listeners } = fakeKafka();
    const hooks: KafkaMetricsHooks = {
      onBatch: () => {
        throw new Error("boom");
      },
      onMessage: () => {},
      observeHandler: () => {},
    };

    createConsumer(kafka, "g", hooks);
    expect(() =>
      listeners[END_BATCH]({ payload: { topic: "t", partition: 0, offsetLag: "1" } })
    ).not.toThrow();
  });
});
```

Note `offsetLag` arrives as a **string** from kafkajs — the `Number(...)` coercion in Step 3 is
what makes the `lag: 17` assertion pass.

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/kafka-hooks.unit.test.ts`
Expected: FAIL — `createConsumer` takes two parameters today and registers no listener, so
`listeners[END_BATCH]` is `undefined`.

- [ ] **Step 3: Wire the hooks into `createConsumer`**

In `packages/shared/src/kafka.ts`, change the signature and add the instrumentation listener:

```ts
import type { KafkaMetricsHooks } from "./metrics";

export function createConsumer(kafka: Kafka, groupId: string, hooks?: KafkaMetricsHooks) {
  const consumer: Consumer = kafka.consumer({ groupId });
  const parker: Producer = kafka.producer();

  if (hooks) {
    // kafkajs hands us offsetLag per topic/partition at the end of every batch. Wrapped
    // because an exception raised inside an instrumentation listener would kill the consumer.
    consumer.on(consumer.events.END_BATCH_PROCESS, (e) => {
      try {
        hooks.onBatch({
          group: groupId,
          topic: e.payload.topic,
          partition: String(e.payload.partition),
          lag: Number(e.payload.offsetLag ?? 0),
        });
      } catch {
        /* never let a metric break consumption */
      }
    });
  }
  // ... rest unchanged
```

Inside `run`'s `eachMessage`, wrap the existing handler call. The existing body parses the
envelope inside the `try` and DLQs on failure — keep that exactly as it is, and add only the
recording:

```ts
        try {
          const env = EventEnvelopeSchema.parse(JSON.parse(raw));
          const started = process.hrtime.bigint();
          await withRetry(() => handler(env), { retries: maxRetries, baseMs: 200 });
          hooks?.observeHandler({
            group: groupId,
            topic,
            type: env.type,
            seconds: Number(process.hrtime.bigint() - started) / 1e9,
          });
          hooks?.onMessage({ group: groupId, topic, result: "ok" });
        } catch (e) {
          hooks?.onMessage({ group: groupId, topic, result: "dlq" });
          // ... existing DLQ/park logic unchanged
```

- [ ] **Step 4: Run the shared suite**

Run: `pnpm vitest run packages/shared`
Expected: PASS — including the pre-existing `kafka-dlq.int.test.ts` and `kafka.int.test.ts`, **unmodified**. The third parameter is optional; if any existing call site fails to compile, the change is wrong.

- [ ] **Step 5: Typecheck**

Run: `pnpm -r typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/kafka.ts packages/shared/src/__tests__/kafka-hooks.unit.test.ts
git commit -m "feat(shared): optional kafka metrics hooks for lag, outcome and handler duration"
```

---

### Task 3: `queueDepth` on the Rabbit adapter

**Files:**
- Modify: `packages/shared/src/rabbitmq.ts`
- Modify: `packages/shared/src/__tests__/rabbitmq.int.test.ts`

**Interfaces:**
- Consumes: `startDlqPoller` from Task 1 (already implemented and tested there).
- Produces: `createRabbit()` return object gains `queueDepth(queue: string): Promise<number>` — the probe Task 5 passes to `startDlqPoller`.

Task 1 already implemented and tested the poller against a stub probe. This task's deliverable is
the **real probe**: `queueDepth` on the Rabbit adapter.

**Why a new method rather than exposing the channel:** `createRabbit` returns a closed surface
(`rabbitmq.ts:155-163`); neither `conn` nor `ch` escapes, so no caller can supply a channel. And
the working channel is the `ConfirmChannel` carrying the relay's command lane — `checkQueue`
against a missing queue closes the channel it runs on, so probing there would let a metric kill
message sending.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/__tests__/rabbitmq.int.test.ts`, inside its existing `describe`.
Read the file first and reuse whatever its existing connection handle is named — do **not** open
a second connection:

```ts
  it("queueDepth reports the DLQ message count", async () => {
    const queue = `metrics-depth-${Date.now()}`;
    await rabbit.assertWorkQueue(queue);
    expect(await rabbit.queueDepth(`${queue}.dlq`)).toBe(0);
  });

  it("queueDepth on a missing queue rejects without killing the command lane", async () => {
    await expect(rabbit.queueDepth(`no-such-queue-${Date.now()}`)).rejects.toThrow();
    // The working ConfirmChannel must still be usable — this is the whole reason
    // queueDepth owns a separate channel.
    const queue = `metrics-after-miss-${Date.now()}`;
    await rabbit.assertWorkQueue(queue);
    expect(await rabbit.queueDepth(`${queue}.dlq`)).toBe(0);
  });
```

The second test is the load-bearing one: it fails if `queueDepth` shares the working channel,
which is exactly the mistake the design forbids.

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/rabbitmq.int.test.ts` (needs `docker compose up -d`)
Expected: FAIL — `rabbit.queueDepth is not a function`.

- [ ] **Step 3: Add `queueDepth` to the Rabbit adapter**

In `packages/shared/src/rabbitmq.ts`, add a lazily-opened dedicated channel and the method, then export it:

```ts
  // Dedicated NON-confirm channel. checkQueue against a missing queue closes the channel it
  // runs on, and `ch` above carries the relay's command lane — a metric must not be able to
  // kill message sending.
  let pollCh: Channel | null = null;
  async function queueDepth(queue: string): Promise<number> {
    try {
      if (!pollCh) pollCh = await conn.createChannel();
      const info = await pollCh.checkQueue(queue);
      return info.messageCount;
    } catch (e) {
      pollCh = null; // the failure closed it; next call reopens
      throw e;
    }
  }
```

Add `Channel` to the amqplib type import on line 1. Add `queueDepth` to the returned object.
In `close()`, close the poll channel before the working channel:

```ts
  async function close(): Promise<void> {
    lifecycle.markClosing();
    if (pollCh) {
      await pollCh.close();
      pollCh = null;
    }
    await ch.close();
    await conn.close();
  }
```

- [ ] **Step 4: Run the shared suite**

Run: `pnpm vitest run packages/shared`
Expected: PASS. The integration tests need `docker compose up -d`.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm -r typecheck && pnpm format:check
git add packages/shared/src/rabbitmq.ts \
        packages/shared/src/__tests__/rabbitmq.int.test.ts
git commit -m "feat(shared): queueDepth on a dedicated channel for DLQ-depth polling"
```

---

### Task 4: Adopt `/metrics` in the four zero-arg services

**Files:**
- Modify: `services/hello/src/app.ts`, `services/inventory/src/app.ts`, `services/catalog/src/app.ts`, `services/identity/src/app.ts`
- Modify: the matching `services/*/src/main.ts` for each
- Create: `services/hello/src/__tests__/metrics.test.ts` (and the same file under `inventory`, `catalog`, `identity`)

**Interfaces:**
- Consumes: `createMetrics`, `Metrics` from Task 1.
- Produces: each `createApp(deps?: { metrics?: Metrics })` — **optional**, so every existing `createApp()` call still compiles.

These four currently read `export function createApp(): express.Application`. Do all four
identically; the example below is `hello`.

- [ ] **Step 1: Write the failing test**

Create `services/hello/src/__tests__/metrics.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app";

describe("hello /metrics", () => {
  it("exposes prometheus metrics stamped with the service name", async () => {
    const app = createApp();
    await request(app).get("/healthz");
    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.text).toContain('service="hello"');
    expect(res.text).toContain("http_requests_total");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run services/hello/src/__tests__/metrics.test.ts`
Expected: FAIL — 404 on `/metrics`.

- [ ] **Step 3: Adopt in `app.ts`**

```ts
import { traceMiddleware, createLogger, createHealthRouter, createMetrics, type Metrics } from "@ecom/shared";

export function createApp(deps: { metrics?: Metrics } = {}): express.Application {
  const metrics = deps.metrics ?? createMetrics("hello");
  const app = express();
  app.use(express.json());
  app.use(traceMiddleware());
  app.use(metrics.httpMiddleware());
  app.use(metrics.router());
  // ... everything else unchanged
```

`metrics.httpMiddleware()` goes **before** the routes so it sees every request; `metrics.router()`
can sit next to it.

- [ ] **Step 4: Wire `main.ts`**

In `services/hello/src/main.ts`, construct once and pass it in — `main.ts` is the only place that opts into default metrics:

```ts
const metrics = createMetrics("hello", { defaultMetrics: true });
const app = createApp({ metrics });
```

For `inventory`, also pass the hooks to its consumer: `createConsumer(kafka, "inventory-consumers", metrics.kafkaHooks)` — use the real group id already in the file.

- [ ] **Step 5: Repeat for `inventory`, `catalog`, `identity`**

Same five edits per service, with the service's own name in `createMetrics` and in the test's
`service="…"` assertion. `catalog` and `identity` run no Kafka consumer, so they pass no hooks.

- [ ] **Step 6: Run all four suites**

Run: `pnpm vitest run services/hello services/inventory services/catalog services/identity`
Expected: PASS, including every pre-existing test unmodified.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm -r typecheck && pnpm format:check
git add services/hello/src/app.ts services/hello/src/main.ts services/hello/src/__tests__/metrics.test.ts \
        services/inventory/src/app.ts services/inventory/src/main.ts services/inventory/src/__tests__/metrics.test.ts \
        services/catalog/src/app.ts services/catalog/src/main.ts services/catalog/src/__tests__/metrics.test.ts \
        services/identity/src/app.ts services/identity/src/main.ts services/identity/src/__tests__/metrics.test.ts
git commit -m "feat(hello,inventory,catalog,identity): expose /metrics"
```

---

### Task 5: Adopt `/metrics` in `order`, `payment`, `notification`

**Files:**
- Modify: `services/order/src/app.ts`, `services/payment/src/app.ts`, `services/notification/src/app.ts`
- Modify: the matching `main.ts` for each
- Create: `services/order/src/__tests__/metrics.test.ts`, and the same under `payment`, `notification`

**Interfaces:**
- Consumes: `createMetrics`, `Metrics` from Task 1; `kafkaHooks` from Task 2; `startDlqPoller` + `queueDepth` from Task 3.
- Produces: `metrics` as an optional field on each service's existing deps object.

These three already take a deps object. `order`'s is optional (`= {}`); `payment` and
`notification` require `{ rabbitHealth }`. Add `metrics?: Metrics` as an **optional field** to
each — do not make the whole object optional where it currently is not.

- [ ] **Step 1: Write the failing test**

Create `services/payment/src/__tests__/metrics.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app";

describe("payment /metrics", () => {
  it("exposes prometheus metrics stamped with the service name", async () => {
    const app = createApp({ rabbitHealth: async () => {} });
    await request(app).get("/healthz");
    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.text).toContain('service="payment"');
  });
});
```

`order`'s version calls `createApp()` with no argument; `notification`'s passes
`{ rabbitHealth: async () => {} }`.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run services/payment/src/__tests__/metrics.test.ts`
Expected: FAIL — 404 on `/metrics`.

- [ ] **Step 3: Adopt in each `app.ts`**

```ts
export function createApp(deps: {
  rabbitHealth: () => Promise<void>;
  metrics?: Metrics;
}): express.Application {
  const metrics = deps.metrics ?? createMetrics("payment");
  // ... after traceMiddleware:
  app.use(metrics.httpMiddleware());
  app.use(metrics.router());
```

- [ ] **Step 4: Wire each `main.ts`**

`order` — construct once, pass to both consumers and `createApp`:

```ts
const metrics = createMetrics("order", { defaultMetrics: true });
const consumer = createConsumer(kafka, "order-consumers", metrics.kafkaHooks);
const catalogConsumer = createConsumer(kafka, "order-catalog-projection", metrics.kafkaHooks);
const app = createApp({ sseRegistry: listener.registry, metrics });
```

`payment` and `notification` additionally start the DLQ poller and stop it in
`gracefulShutdown`, next to the existing `pruner.stop()` entry:

```ts
const metrics = createMetrics("payment", { defaultMetrics: true });
const dlqPoller = metrics.startDlqPoller(rabbit.queueDepth, ["payment.charge.dlq"]);
// ... inside gracefulShutdown's array, alongside pruner.stop():
async () => {
  dlqPoller.stop();
},
```

Use each service's real queue names — read them from the file rather than assuming. `order` also
sends on `payment.charge`, but the DLQ belongs to the consumer side, so only `payment` polls it.
`notification` polls `notifications.dlq`.

- [ ] **Step 5: Run the three suites**

Run: `pnpm vitest run services/order services/payment services/notification`
Expected: PASS, all pre-existing tests unmodified.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm -r typecheck && pnpm format:check
git add services/order/src/app.ts services/order/src/main.ts services/order/src/__tests__/metrics.test.ts \
        services/payment/src/app.ts services/payment/src/main.ts services/payment/src/__tests__/metrics.test.ts \
        services/notification/src/app.ts services/notification/src/main.ts services/notification/src/__tests__/metrics.test.ts
git commit -m "feat(order,payment,notification): expose /metrics and poll DLQ depth"
```

---

### Task 6: Gateway — separate metrics port and proxy-mount labels

**Files:**
- Modify: `services/gateway/src/config.ts`, `services/gateway/src/app.ts`, `services/gateway/src/main.ts`
- Modify: `services/gateway/.env.example`
- Create: `services/gateway/src/__tests__/metrics.test.ts`

**Interfaces:**
- Consumes: `createMetrics`, `Metrics`, `resolveRoute` precedence from Task 1.
- Produces: gateway `/metrics` on `METRICS_PORT`, absent from the app port.

**Why a separate port:** port 8000 is the only port `docker-compose.prod.example.yml` publishes,
so `/metrics` mounted there would be internet-facing. The alternative — a deny rule in the
gateway's rules table — was rejected because 7a's Critical C2 was a case-varied path bypassing
that exact table.

- [ ] **Step 1: Write the failing test**

Create `services/gateway/src/__tests__/metrics.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createMetrics } from "@ecom/shared";

describe("gateway metrics", () => {
  it("labels a proxy mount by the mount and its upstream, never the raw path", async () => {
    const m = createMetrics("gateway");
    const app = express().use(m.httpMiddleware());
    app.use("/orders", (_req, res) => {
      res.locals.metricsRoute = "/orders";
      res.locals.metricsUpstream = "order";
      res.json({ ok: true });
    });
    app.use(m.router());

    await request(app).get("/orders/abc-123/items");
    const out = await m.registry.metrics();

    expect(out).toContain('route="/orders"');
    expect(out).toContain('upstream="order"');
    expect(out).not.toContain("abc-123");
  });
});
```

Add a second test asserting `/metrics` is **not** mounted on the main app — build the real
`createApp` with its required `GatewayDeps` (copy the deps construction from an existing gateway
test file) and assert `GET /metrics` returns 404.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run services/gateway/src/__tests__/metrics.test.ts`
Expected: FAIL on the labels.

- [ ] **Step 3: Add `METRICS_PORT` to config**

In `services/gateway/src/config.ts`'s zod schema:

```ts
    METRICS_PORT: z.coerce.number().default(9464),
```

A **default is mandatory**. A required key with no default is the 7a Task-7 failure shape
(`PAYMENT_WEBHOOK_SECRET`), where an ad-hoc run refuses to boot. A metrics port must never stop
the gateway from starting.

Add to `services/gateway/.env.example`:

```
METRICS_PORT=9464
```

- [ ] **Step 4: Set the labels in `guard`**

In `services/gateway/src/app.ts`, inside `guard(name, target)` (around line 178), set the two
locals before delegating to the breaker-wrapped proxy handler:

```ts
  const guard = (name: string, target: string) => {
    // ... existing memoisation
    const handler = guardWithBreaker(name, createUpstreamProxy(target), deps.breaker);
    return (req: Request, res: Response, next: NextFunction) => {
      res.locals.metricsRoute = req.baseUrl; // the registered mount — bounded, and normalised
      res.locals.metricsUpstream = name;
      return handler(req, res, next);
    };
  };
```

Then mount the RED middleware in `createApp` after `traceMiddleware()`, as in every other
service — but **not** `metrics.router()`. The gateway's router is mounted on its own listener in
`main.ts`.

- [ ] **Step 5: Second listener in `main.ts`**

```ts
const metrics = createMetrics("gateway", { defaultMetrics: true });
const app = createApp({ ...existingDeps, metrics });
const server = app.listen(config.PORT, () => log.info("gateway_listening", { port: config.PORT }));

// Separate, deliberately unpublished port — /metrics must not be reachable on the one port
// the prod compose profile exposes.
const metricsApp = express().use(metrics.router());
const metricsServer = metricsApp.listen(config.METRICS_PORT, () =>
  log.info("gateway_metrics_listening", { port: config.METRICS_PORT })
);
```

Add its close to `gracefulShutdown`, as its own entry before the main `server.close()`:

```ts
    async () => {
      await new Promise<void>((resolve, reject) =>
        metricsServer.close((err) => (err ? reject(err) : resolve()))
      );
    },
```

- [ ] **Step 6: Run the gateway suite**

Run: `pnpm vitest run services/gateway`
Expected: PASS, all 27+ pre-existing tests unmodified.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm -r typecheck && pnpm format:check
git add services/gateway/src/app.ts services/gateway/src/main.ts services/gateway/src/config.ts \
        services/gateway/.env.example services/gateway/src/__tests__/metrics.test.ts
git commit -m "feat(gateway): /metrics on a separate unpublished port, proxy-mount RED labels"
```

---

### Task 7: Order saga metrics

**Files:**
- Create: `services/order/src/metrics.ts`
- Modify: `services/order/src/consumer.ts`
- Create: `services/order/src/__tests__/saga-metrics.unit.test.ts`

**Interfaces:**
- Consumes: `Metrics` from Task 1.
- Produces: `createSagaMetrics(registry): { observeStep(step, seconds), observeSaga(outcome, seconds) }`.

**Recording happens in the caller, after the transaction commits — never inside
`transition.ts`.** That module is pure behind a tx port; recording inside it would count
transitions that later rolled back, and would change a pure module's contract. 7a made
`setStatus` a compare-and-set whose `false` return is a `NO_OP` that emits nothing — it must
record nothing either.

- [ ] **Step 1: Write the failing test**

Create `services/order/src/__tests__/saga-metrics.unit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createMetrics } from "@ecom/shared";
import { createSagaMetrics } from "../metrics";

describe("saga metrics", () => {
  it("observes step and total duration with the expected labels", async () => {
    const m = createMetrics("order");
    const saga = createSagaMetrics(m.registry);

    saga.observeStep("reserve", 0.4);
    saga.observeSaga("confirmed", 1.2);

    const out = await m.registry.metrics();
    expect(out).toContain('saga_step_duration_seconds_bucket{step="reserve"');
    expect(out).toContain('saga_duration_seconds_bucket{outcome="confirmed"');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run services/order/src/__tests__/saga-metrics.unit.test.ts`
Expected: FAIL — `Failed to resolve import "../metrics"`.

- [ ] **Step 3: Write the domain module**

Create `services/order/src/metrics.ts`:

```ts
import { Histogram, type Registry } from "prom-client";

// Straddles the roadmap's saga p99 < 5s SLO.
const SAGA_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

export function createSagaMetrics(registry: Registry) {
  const stepDuration = new Histogram({
    name: "saga_step_duration_seconds",
    help: "Duration of one checkout saga step",
    labelNames: ["step"],
    buckets: SAGA_BUCKETS,
    registers: [registry],
  });
  const sagaDuration = new Histogram({
    name: "saga_duration_seconds",
    help: "Duration of a checkout saga from order creation to a terminal status",
    labelNames: ["outcome"],
    buckets: SAGA_BUCKETS,
    registers: [registry],
  });

  return {
    observeStep: (step: "reserve" | "payment", seconds: number) =>
      stepDuration.observe({ step }, seconds),
    observeSaga: (outcome: "confirmed" | "cancelled", seconds: number) =>
      sagaDuration.observe({ outcome }, seconds),
  };
}

export type SagaMetrics = ReturnType<typeof createSagaMetrics>;
```

`prom-client` is a transitive dependency here via `@ecom/shared`; importing its types is fine and
does not require adding it to `services/order/package.json`.

- [ ] **Step 4: Record at the caller**

`services/order/src/consumer.ts:36-52` is the seam. Three facts make this straightforward and you
must not work around any of them:

- `applyResult` already returns `ApplyOutcome` (`transition.ts:38-44`), where a **real**
  transition is exactly `AWAITING_PAYMENT | CANCELLED | CONFIRMED`. `NO_OP` (which is also what a
  lost compare-and-set returns), `DUPLICATE` and `UNKNOWN_ORDER` must record nothing. **No change
  to `applyResult`'s signature or return type is needed.**
- `prisma.$transaction(...)` has already committed by the time `outcome` is assigned, so
  recording after that line satisfies the after-commit rule for free.
- The `Order` model carries both `createdAt` and `updatedAt @updatedAt`
  (`services/order/prisma/schema.prisma:31-40`), so both durations come from a **read taken
  before the transaction**. This read is advisory — it gates no write, so it cannot reintroduce
  the read-then-write race 7a's compare-and-set closed.

`handleEvent` is imported directly by existing tests, so it must keep its exact signature. Inject
via a module-level setter defaulting to a no-op:

```ts
import type { SagaMetrics } from "./metrics";

const NOOP_SAGA: SagaMetrics = { observeStep: () => {}, observeSaga: () => {} };
let saga: SagaMetrics = NOOP_SAGA;

// main.ts injects the real one. Default is a no-op so every existing test that imports
// handleEvent keeps working untouched.
export function setSagaMetrics(m: SagaMetrics): void {
  saga = m;
}

export async function handleEvent(env: EventEnvelope): Promise<void> {
  const orderId = orderIdOf(env);
  if (orderId === null) return; // not ours

  // Advisory pre-read for the saga clock only — gates no write.
  const before = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true, createdAt: true, updatedAt: true },
  });

  const outcome = await prisma.$transaction((tx) =>
    applyResult(transitionTx(tx, env.traceId), {
      eventId: env.eventId,
      type: env.type,
      orderId,
    })
  );

  // Only a real transition is measured. NO_OP covers the lost CAS, which emits nothing
  // and must therefore record nothing.
  if (before && (outcome === "AWAITING_PAYMENT" || outcome === "CANCELLED" || outcome === "CONFIRMED")) {
    const now = Date.now();
    saga.observeStep(
      before.status === "PENDING" ? "reserve" : "payment",
      (now - before.updatedAt.getTime()) / 1000
    );
    if (outcome === "CONFIRMED" || outcome === "CANCELLED") {
      saga.observeSaga(
        outcome === "CONFIRMED" ? "confirmed" : "cancelled",
        (now - before.createdAt.getTime()) / 1000
      );
    }
  }

  log.info("saga_event_handled", {
    orderId,
    type: env.type,
    outcome,
    traceId: env.traceId,
  });
}
```

A freshly created order has `updatedAt === createdAt`, so the `reserve` step measures from order
creation, which is what it should measure. A `PENDING → CANCELLED` reservation failure correctly
records both a `reserve` step and a `cancelled` saga.

In `services/order/src/main.ts`, inject the real implementation:

```ts
setSagaMetrics(createSagaMetrics(metrics.registry));
```

- [ ] **Step 5: Add the outcome-gating test**

Append to `saga-metrics.unit.test.ts` — this pins the rule that a `NO_OP` records nothing:

```ts
import { setSagaMetrics } from "../consumer";

describe("saga metrics gating", () => {
  it("records nothing for a NO_OP outcome", async () => {
    const m = createMetrics("order");
    const seen: string[] = [];
    setSagaMetrics({
      observeStep: (step) => seen.push(`step:${step}`),
      observeSaga: (outcome) => seen.push(`saga:${outcome}`),
    });

    // A lost compare-and-set returns NO_OP from applyResult; the caller must not record.
    // Drive applyResult directly with a fake tx whose setStatus returns false.
    const { applyResult } = await import("../transition");
    const outcome = await applyResult(
      {
        loadOrder: async () => ({ status: "PENDING", totalPrice: 100, userId: "u1" }),
        markProcessed: async () => true,
        setStatus: async () => false, // lost CAS
        enqueue: async () => {},
        notify: async () => {},
      },
      { eventId: "e1", type: "inventory.reserved", orderId: "o1" }
    );

    expect(outcome).toBe("NO_OP");
    expect(seen).toEqual([]);
    expect(await m.registry.metrics()).not.toContain("saga_duration_seconds_count");
  });
});
```

Use the real event-type constant from `@ecom/contracts` rather than the string literal above —
read `INVENTORY_RESERVED`'s value from the import in `transition.ts`.

- [ ] **Step 6: Run the order suite**

Run: `pnpm vitest run services/order`
Expected: PASS, all 56 pre-existing tests unmodified.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm -r typecheck && pnpm format:check
git add services/order/src/metrics.ts services/order/src/consumer.ts services/order/src/main.ts \
        services/order/src/__tests__/saga-metrics.unit.test.ts
git commit -m "feat(order): saga duration and step-latency histograms recorded after commit"
```

---

### Task 8: Inventory reservation outcomes

**Files:**
- Create: `services/inventory/src/metrics.ts`
- Modify: `services/inventory/src/consumer.ts`
- Create: `services/inventory/src/__tests__/reservation-metrics.unit.test.ts`

**Interfaces:**
- Consumes: `Metrics` from Task 1.
- Produces: `createReservationMetrics(registry): { observe(outcome: "RESERVED" | "FAILED" | "DUPLICATE"): void }`.

`reserveOrder` (`services/inventory/src/reserve.ts:21-49`) already returns exactly
`"DUPLICATE" | "RESERVED" | "FAILED"`, and `consumer.ts:41` is its single call site. One counter
at that seam gives the conflict rate (`FAILED` = insufficient stock, the only business failure
`reserveOrder` produces) and the idempotency-dedup rate together.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { createMetrics } from "@ecom/shared";
import { createReservationMetrics } from "../metrics";

describe("reservation metrics", () => {
  it("counts each outcome under its own label", async () => {
    const m = createMetrics("inventory");
    const r = createReservationMetrics(m.registry);

    r.observe("RESERVED");
    r.observe("FAILED");
    r.observe("DUPLICATE");

    const out = await m.registry.metrics();
    // Label-order-independent: setDefaultLabels appends service= to every sample,
    // so never pin the closing brace of a sample line.
    expect(out).toMatch(/reservation_outcomes_total\{[^}]*outcome="RESERVED"[^}]*\} 1/);
    expect(out).toMatch(/reservation_outcomes_total\{[^}]*outcome="FAILED"[^}]*\} 1/);
    expect(out).toMatch(/reservation_outcomes_total\{[^}]*outcome="DUPLICATE"[^}]*\} 1/);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run services/inventory/src/__tests__/reservation-metrics.unit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
import { Counter, type Registry } from "prom-client";

export type ReservationOutcome = "RESERVED" | "FAILED" | "DUPLICATE";

export function createReservationMetrics(registry: Registry) {
  const outcomes = new Counter({
    name: "reservation_outcomes_total",
    help: "Inventory reservation attempts by outcome",
    labelNames: ["outcome"],
    registers: [registry],
  });
  return { observe: (outcome: ReservationOutcome) => outcomes.inc({ outcome }) };
}

export type ReservationMetrics = ReturnType<typeof createReservationMetrics>;
```

- [ ] **Step 4: Record at the call site**

`services/inventory/src/consumer.ts:40-52` (`handlePlaced`) already assigns
`outcome` from `await prisma.$transaction(...)`, so the transaction has committed and the value
is exactly `"DUPLICATE" | "RESERVED" | "FAILED"`. One line, no other change.

`handleOrderEvent` is imported directly by existing tests, so use the same no-op-default setter
pattern as Task 7:

```ts
import type { ReservationMetrics } from "./metrics";

const NOOP_RESERVATION: ReservationMetrics = { observe: () => {} };
let reservation: ReservationMetrics = NOOP_RESERVATION;

// main.ts injects the real one; the no-op default keeps every existing test untouched.
export function setReservationMetrics(m: ReservationMetrics): void {
  reservation = m;
}
```

Then inside `handlePlaced`, immediately after the existing `const outcome = await
prisma.$transaction(...)` block and before the existing `log.info`:

```ts
    reservation.observe(outcome);
```

Do **not** move it inside the `try`'s transaction callback — the lock-release `finally` and the
transaction boundary both sit around it, and recording inside would count reservations that
later rolled back.

In `services/inventory/src/main.ts`:

```ts
setReservationMetrics(createReservationMetrics(metrics.registry));
```

- [ ] **Step 5: Run the inventory suite**

Run: `pnpm vitest run services/inventory`
Expected: PASS, all 24 pre-existing tests unmodified.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm -r typecheck && pnpm format:check
git add services/inventory/src/metrics.ts services/inventory/src/consumer.ts services/inventory/src/main.ts \
        services/inventory/src/__tests__/reservation-metrics.unit.test.ts
git commit -m "feat(inventory): reservation outcome counter at the reserveOrder seam"
```

---

### Task 9: Payment and notification counters

**Files:**
- Create: `services/payment/src/metrics.ts`, `services/notification/src/metrics.ts`
- Modify: `services/payment/src/consumer.ts` (or the module owning charge finalisation), `services/notification/src/worker.ts` (or the module owning send)
- Create: `services/payment/src/__tests__/payment-metrics.unit.test.ts`, `services/notification/src/__tests__/notification-metrics.unit.test.ts`

**Interfaces:**
- Produces: `createPaymentMetrics(registry): { observe(outcome: "succeeded" | "failed" | "processing"): void }` and `createNotificationMetrics(registry): { observe(type: string, result: string): void }`.

`processing` is the `%100 == 99` webhook-pending path from Phase 3c. Without these two counters
the dashboard goes dark after Order, which defeats an end-to-end checkout view.

- [ ] **Step 1: Write both failing tests**

```ts
import { describe, it, expect } from "vitest";
import { createMetrics } from "@ecom/shared";
import { createPaymentMetrics } from "../metrics";

describe("payment metrics", () => {
  it("counts attempts by outcome", async () => {
    const m = createMetrics("payment");
    const p = createPaymentMetrics(m.registry);
    p.observe("succeeded");
    p.observe("processing");
    const out = await m.registry.metrics();
    // Label-order-independent: setDefaultLabels appends service= to every sample,
    // so never pin the closing brace of a sample line.
    expect(out).toMatch(/payment_attempts_total\{[^}]*outcome="succeeded"[^}]*\} 1/);
    expect(out).toMatch(/payment_attempts_total\{[^}]*outcome="processing"[^}]*\} 1/);
  });
});
```

The notification version asserts, in the same label-order-independent form:

```ts
    expect(out).toMatch(/notifications_sent_total\{[^}]*type="order_confirmed"[^}]*\} 1/);
    expect(out).toMatch(/notifications_sent_total\{[^}]*result="sent"[^}]*\} 1/);
```

- [ ] **Step 2: Run both and confirm failure**

Run: `pnpm vitest run services/payment/src/__tests__/payment-metrics.unit.test.ts services/notification/src/__tests__/notification-metrics.unit.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write both modules**

`services/payment/src/metrics.ts`:

```ts
import { Counter, type Registry } from "prom-client";

export type PaymentOutcome = "succeeded" | "failed" | "processing";

export function createPaymentMetrics(registry: Registry) {
  const attempts = new Counter({
    name: "payment_attempts_total",
    help: "Payment charge attempts by outcome",
    labelNames: ["outcome"],
    registers: [registry],
  });
  return { observe: (outcome: PaymentOutcome) => attempts.inc({ outcome }) };
}

export type PaymentMetrics = ReturnType<typeof createPaymentMetrics>;
```

`services/notification/src/metrics.ts`:

```ts
import { Counter, type Registry } from "prom-client";

export type SendResult = "sent" | "skipped" | "failed";

export function createNotificationMetrics(registry: Registry) {
  const sent = new Counter({
    name: "notifications_sent_total",
    help: "Notification send attempts by template type and result",
    labelNames: ["type", "result"],
    registers: [registry],
  });
  return { observe: (type: string, result: SendResult) => sent.inc({ type, result }) };
}

export type NotificationMetrics = ReturnType<typeof createNotificationMetrics>;
```

- [ ] **Step 4: Record at the payment seam**

`services/payment/src/consumer.ts:32` already assigns `outcome` from a committed
`prisma.$transaction(...)`. `ChargeOutcome` is `"DUPLICATE" | "ALREADY_CHARGED" | "SUCCEEDED" |
"FAILED" | "PROCESSING"` (`charge.ts:27-28`); only the last three are attempts. Use the same
no-op-default setter as Tasks 7 and 8:

```ts
import type { PaymentMetrics } from "./metrics";

const NOOP_PAYMENT: PaymentMetrics = { observe: () => {} };
let payment: PaymentMetrics = NOOP_PAYMENT;

export function setPaymentMetrics(m: PaymentMetrics): void {
  payment = m;
}
```

Immediately after the existing `const outcome = await prisma.$transaction(...)`, before the
existing `log.info("charge_handled", ...)`:

```ts
  // DUPLICATE and ALREADY_CHARGED are idempotency short-circuits, not attempts.
  if (outcome === "SUCCEEDED") payment.observe("succeeded");
  else if (outcome === "FAILED") payment.observe("failed");
  else if (outcome === "PROCESSING") payment.observe("processing");
```

In `services/payment/src/main.ts`: `setPaymentMetrics(createPaymentMetrics(metrics.registry));`

- [ ] **Step 5: Record at the notification seam**

`applySend` (`services/notification/src/worker.ts:23-34`) owns the row and therefore the `type`
label, but its return is only `"SENT" | "SKIP"`. Add an **optional** fourth parameter so every
existing call site and test keeps compiling unchanged:

```ts
export async function applySend(
  port: WorkerPort,
  mailer: Mailer,
  notificationId: string,
  record?: (type: string, result: "sent" | "skipped" | "failed") => void
): Promise<"SENT" | "SKIP"> {
  const row = await port.loadRow(notificationId);
  if (row === null || row.status === "SENT") return "SKIP"; // redelivery / dedup
  const { subject, html } = renderTemplate(row.type, { orderId: row.orderId });
  try {
    await mailer.send({ to: row.to, subject, html }); // throws -> caller retries -> DLQ
  } catch (e) {
    record?.(row.type, "failed");
    throw e; // rethrow unchanged: the retry/DLQ behaviour must not change
  }
  const n = await port.casSent(notificationId);
  record?.(row.type, n > 0 ? "sent" : "skipped");
  return n > 0 ? "SENT" : "SKIP"; // a concurrent worker won the CAS
}
```

`makeHandleSendEmail` is already a factory, so it takes the metrics as an optional second
parameter rather than needing a setter:

```ts
export function makeHandleSendEmail(mailer: Mailer, metrics?: NotificationMetrics) {
  return async function handleSendEmail(env: EventEnvelope): Promise<void> {
    const { notificationId } = SendEmailPayloadSchema.parse(env.payload);
    const outcome = await applySend(workerPort, mailer, notificationId, metrics?.observe);
    log.info("send_email_handled", { notificationId, outcome, traceId: env.traceId });
  };
}
```

In `services/notification/src/main.ts`, pass it:
`makeHandleSendEmail(mailer, createNotificationMetrics(metrics.registry))`.

The rethrow is load-bearing: swallowing the mailer error here would silently disable the retry
and DLQ path that Phase 5 built.

- [ ] **Step 6: Run both suites**

Run: `pnpm vitest run services/payment services/notification`
Expected: PASS, all pre-existing tests unmodified — in particular the existing `applySend` and
`makeHandleSendEmail` tests, which must keep compiling against the new optional parameters.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm -r typecheck && pnpm format:check
git add services/payment/src/metrics.ts services/payment/src/consumer.ts services/payment/src/main.ts \
        services/payment/src/__tests__/payment-metrics.unit.test.ts \
        services/notification/src/metrics.ts services/notification/src/worker.ts services/notification/src/main.ts \
        services/notification/src/__tests__/notification-metrics.unit.test.ts
git commit -m "feat(payment,notification): attempt and send counters"
```

---

### Task 10: Prometheus, Grafana and the dashboard

**Files:**
- Create: `infra/prometheus/prometheus.yml`, `infra/grafana/provisioning/datasources/prometheus.yml`, `infra/grafana/provisioning/dashboards/dashboards.yml`, `infra/grafana/dashboards/checkout.json`
- Modify: `docker-compose.example.yml`, `docker-compose.prod.example.yml`, `.env.example`, `docs/infra.md`

**Interfaces:**
- Consumes: `/metrics` on all eight services from Tasks 4-6.
- Produces: nothing consumed by later tasks.

There is no unit test here. The acceptance test is a real checkout observed on the dashboard —
hand-authored dashboard JSON is verbose and easy to get subtly wrong, so it is validated by
loading it, not by reading it.

- [ ] **Step 1: Resolve and pin the image tags**

Look up the current stable tag for `prom/prometheus` and `grafana/grafana` and pin those exact
versions. Do **not** use `:latest` — a committed dashboard JSON is version-coupled to the Grafana
that renders it, and a moving tag breaks it on someone else's clone.

- [ ] **Step 2: Write the Prometheus scrape config**

Create `infra/prometheus/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: ecom-services
    static_configs:
      - targets:
          - hello:3000
          - inventory:3001
          - order:3002
          - payment:3003
          - catalog:3004
          - notification:3005
          - identity:3006
          - gateway:9464
```

Gateway is `9464`, not `8000` — its `/metrics` lives on the separate unpublished port from
Task 6. Verify each other port against `docker-compose.example.yml` before committing.

- [ ] **Step 3: Add both services to compose**

In `docker-compose.example.yml`:

```yaml
  prometheus:
    image: prom/prometheus:<pinned>
    ports: ["9090:9090"]
    volumes:
      - ./infra/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:9090/-/healthy"]
      interval: 10s
      timeout: 5s
      retries: 10
    restart: unless-stopped

  grafana:
    image: grafana/grafana:<pinned>
    ports: ["3007:3000"]          # 3000-3006 are taken by the services
    environment:
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_PASSWORD:-ecom}
    volumes:
      - ./infra/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./infra/grafana/dashboards:/var/lib/grafana/dashboards:ro
    depends_on: [prometheus]
    restart: unless-stopped
```

Match the surrounding entries' style — every app service already carries `restart: unless-stopped`.

In `docker-compose.prod.example.yml`, add both with `ports: !reset []`, exactly like every other
non-gateway service. Note that compose **merges** port lists, so a bare `[]` silently does
nothing — `!reset` is required.

Add `GRAFANA_PASSWORD=ecom` to the root `.env.example`, and add the gateway's `METRICS_PORT` to
its compose `environment:` block.

- [ ] **Step 4: Provision the datasource and dashboard loader**

`infra/grafana/provisioning/datasources/prometheus.yml`:

```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
```

`infra/grafana/provisioning/dashboards/dashboards.yml`:

```yaml
apiVersion: 1
providers:
  - name: ecom
    type: file
    options:
      path: /var/lib/grafana/dashboards
```

- [ ] **Step 5: Build the dashboard**

Create `infra/grafana/dashboards/checkout.json`. Use this exact envelope and panel shape — the
first two panels are written out in full so the structure is unambiguous; the remaining seven
follow the same shape with the queries listed below:

```json
{
  "uid": "ecom-checkout",
  "title": "Checkout — RED & saga",
  "schemaVersion": 39,
  "refresh": "10s",
  "time": { "from": "now-15m", "to": "now" },
  "panels": [
    {
      "id": 1,
      "type": "timeseries",
      "title": "Request rate",
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
      "targets": [
        {
          "expr": "sum by (service) (rate(http_requests_total[1m]))",
          "legendFormat": "{{service}}",
          "refId": "A"
        }
      ]
    },
    {
      "id": 2,
      "type": "timeseries",
      "title": "Error ratio",
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
      "fieldConfig": { "defaults": { "unit": "percentunit" }, "overrides": [] },
      "targets": [
        {
          "expr": "sum by (service) (rate(http_requests_total{status=~\"5..\"}[5m])) / sum by (service) (rate(http_requests_total[5m]))",
          "legendFormat": "{{service}}",
          "refId": "A"
        }
      ]
    }
  ]
}
```

Panels are laid out two per row (`w: 12`), incrementing `y` by 8 each row. The nine panels and
no others:

1. Request rate — `sum by (service) (rate(http_requests_total[1m]))`
2. Error ratio — `sum by (service) (rate(http_requests_total{status=~"5.."}[5m])) / sum by (service) (rate(http_requests_total[5m]))`
3. Latency p95 — `histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[5m])))`, with a 0.5 threshold line
4. Saga duration p50/p95/p99 — `histogram_quantile(0.99, sum by (le) (rate(saga_duration_seconds_bucket[5m])))` and siblings, with a 5 threshold line
5. Saga step latency — same shape, `sum by (le, step)`
6. Reservation outcomes — `sum by (outcome) (rate(reservation_outcomes_total[5m]))`
7. Payment attempts — `sum by (outcome) (rate(payment_attempts_total[5m]))`
8. Consumer lag — `kafka_consumer_lag`, **with `up` on the same panel**. Lag only updates when a batch completes, so a crashed consumer leaves the gauge stale rather than climbing; `up == 0` next to a flat lag is what distinguishes dead from idle.
9. DLQ depth — `rabbitmq_dlq_depth` by queue

Only `order`, `inventory` and `notification` run Kafka consumers, so panel 8 shows four
group rows, not eight. That is expected, not a broken panel.

- [ ] **Step 6: Verify against a real checkout**

```bash
docker compose up -d
docker compose ps          # all healthy, including prometheus and grafana
```

Open `http://localhost:9090/targets` — all 8 targets `up`. Then drive one real checkout through
the gateway (register → login → place order), and open `http://localhost:3007`. Confirm every
panel resolves and that panels 4-7 move. A panel showing "No data" after a real checkout is a
bug in that panel's query, not an acceptable outcome.

- [ ] **Step 7: Document it**

In `docs/infra.md`, add Prometheus (`http://localhost:9090`) and Grafana
(`http://localhost:3007`, credentials from `.env`) to the endpoint table, and note that the
gateway's metrics are on `METRICS_PORT`, not 8000.

- [ ] **Step 8: Commit**

```bash
git add infra/prometheus/prometheus.yml \
        infra/grafana/provisioning/datasources/prometheus.yml \
        infra/grafana/provisioning/dashboards/dashboards.yml \
        infra/grafana/dashboards/checkout.json \
        docker-compose.example.yml docker-compose.prod.example.yml .env.example docs/infra.md
git commit -m "feat(infra): prometheus + grafana with a provisioned checkout dashboard"
```

---

### Task 11: Correct the roadmap's Phase 7 prose

**Files:**
- Modify: `docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md` (the "Phase 7 — Hardening & verification" section, around lines 111-122)

**Interfaces:** none — documentation only.

The prose still describes the pre-7a slice model (7a=metrics, 7b=OTel, 7c=k6+chaos). 7a's spec
re-cut it as **7a debt / 7b metrics / 7c tracing / 7d verification**, and 7a's fix wave corrected
the absorption-map rows below the prose, leaving the two contradicting each other. This was
surfaced by the 7a fix-wave re-review and explicitly deferred here.

- [ ] **Step 1: Rewrite the Slices line**

Change the four-slice description to `7a` debt (done) → `7b` metrics → `7c` tracing → `7d` k6 +
chaos + retention + the two lesson items. Keep the Scope-in, Scope-out, Risks, Parked and
Done-when paragraphs as they are — only the slice decomposition is wrong.

- [ ] **Step 2: Verify nothing else contradicts**

Run: `grep -n "7a\|7b\|7c\|7d" docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md`
Expected: every remaining mention matches the four-slice model. 7a's fix wave had to correct
this same drift four separate times, so check the decision rows and the absorption map too, not
just the prose you edited.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md
git commit -m "docs(roadmap): Phase 7 prose matches the four-slice model"
```

---

## Final Gate

- [ ] **Full regression on the final tree**

Run: `pnpm -r typecheck && pnpm format:check && pnpm vitest run`
Expected: every pre-existing test green and **unmodified** — 304 tests / 75 files at the 7a
merge, plus the new ones. `packages/shared` changed in Tasks 1-3 and every service depends on it,
so the whole suite must run against the final tree, not per-task snapshots.

- [ ] **Definition of Done** (from spec §I)
  - All 8 services expose `/metrics`; the gateway's is on `METRICS_PORT` and absent from 8000.
  - `docker compose up -d` brings Prometheus up with all 8 targets `up`, and Grafana with the dashboard provisioned.
  - One Grafana dashboard shows a full checkout's RED + saga metrics, driven by a real order through the gateway.
  - The four roadmap domain metrics plus the two §C5 extras all move under load.
  - No business-logic change: every pre-existing test passes unmodified.
  - `roadmap.md`'s Phase 7 prose matches the four-slice model.
