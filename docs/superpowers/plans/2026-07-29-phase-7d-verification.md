# Phase 7d — Verification (k6, chaos, SLO alerts) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Phase 7 by proving the two Done-when criteria that remain — k6 meets the SLOs, and killing Kafka mid-saga loses nothing and duplicates nothing.

**Architecture:** An invariant checker reads all seven service databases plus the Kafka DLQ topics and asserts the saga's safety properties. Both the k6 load run and the chaos suite end by running it, so "zero lost or double effects" is machine-checked rather than asserted. Prometheus burn-rate rules are validated by an outage the chaos suite induces on a service the gateway actually proxies.

**Tech Stack:** TypeScript via `tsx`, `pg` (raw SQL), `kafkajs` admin, `grafana/k6:0.55.0`, bash, Prometheus recording/alerting rules.

**Spec:** `docs/superpowers/specs/2026-07-29-phase-7d-verification-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

1. **A check that cannot fail proves nothing.** This is the lesson Phase 7 has paid for repeatedly — six plan-supplied tests in 7c would have passed against broken implementations, and two invariants were cut from this spec for being database-enforced. Every test here must be shown to fail when the thing it protects is removed. If a check cannot be made to fail, say so rather than reporting a pass.
2. **No business-logic change.** Nothing under `services/*/src/` or `packages/*/src/` changes. This slice adds verification tooling only. Every pre-existing test passes unmodified.
3. **`pnpm lint` is part of every task's exit criteria**, alongside `pnpm -r typecheck` and `pnpm format:check`. 7c ran nine tasks without it and CI caught two lint errors at merge time.
4. **Commit specific files, never `git add -A`.**
5. **Never commit `docker-compose.yml` or `.env`** — only the `*.example.yml` templates and `.env.example` are tracked.
6. **No sensitive data in logs or script output** — IDs and counts, never payloads or credentials.

**Environment on this machine:** an unrelated `eda-platform` stack holds 5432, 9090, 4318 and 1025/8025. The ecom stack runs with a scratchpad override: **Postgres on 5433**, mailpit on 1026/8026. Kafka 9092, RabbitMQ 5672, Redis 6379, Jaeger 16686, Prometheus 9091, Grafana 3007 are as published. Bring the stack up with `-f docker-compose.example.yml` (the local `docker-compose.yml` predates prometheus/grafana/jaeger). Run `bash infra/scripts/reset-dev-topics.sh` before trusting any e2e failure.

**Database names:** `hello`, `identity`, `catalog`, `order`, `inventory`, `payment`, `notification`. Note `order` is a SQL reserved word — it is quoted in `infra/postgres/init/01-databases.sql` and needs no quoting inside a connection URL.

**Prisma table naming:** models map to PascalCase table names requiring double quotes in raw SQL — `"Order"`, `"Payment"`, `"Reservation"`, `"Outbox"`, `"ProcessedEvent"`.

---

### Task 1: Invariant checker — skeleton and the single-database invariants

**Files:**
- Create: `infra/scripts/check-invariants.ts`
- Create: `infra/scripts/__tests__/check-invariants.int.test.ts`
- Modify: `package.json` (root — add `pg` and `@types/pg` as devDependencies)

**Interfaces:**
- Produces: `runInvariants(opts): Promise<Violation[]>` where
  `Violation = { invariant: string; database: string; rows: unknown[] }`.
  Later tasks add invariants to the same array and call the same entry point.

Invariants 1, 3 and 4 each read a single database, so they land together. Invariants 2 and 6 (cross-service) are Task 2; invariant 5 (DLQ) is Task 3.

- [ ] **Step 1: Add the dependencies**

```bash
pnpm add -D -w pg @types/pg
```

`-w` targets the workspace root. `pg` exists today only in `services/order` (`package.json:16`) for the SSE `LISTEN` client; this is a verification script, not shipped code, so it belongs at the root as a devDependency rather than in `packages/shared` where it would become a production dependency of all 8 services.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "crypto";
import { runInvariants } from "../check-invariants";

const PG = process.env.PGBASE ?? "postgresql://ecom:ecom@localhost:5433";

async function sql(db: string, text: string, params: unknown[] = []) {
  const c = new Client({ connectionString: `${PG}/${db}` });
  await c.connect();
  try {
    return await c.query(text, params);
  } finally {
    await c.end();
  }
}

// Each test seeds exactly one violation and asserts the checker reports it.
// Every one of these must fail if its invariant's query is deleted — that is
// the point of the suite, and Global Constraint 1.
describe("invariant checker — single-database invariants (integration)", () => {
  const tag = randomUUID().slice(0, 8);

  afterAll(async () => {
    await sql("order", `DELETE FROM "Order" WHERE "userId" = $1`, [`inv-${tag}`]);
    await sql("order", `DELETE FROM "Outbox" WHERE producer = $1`, [`inv-${tag}`]);
    await sql("inventory", `DELETE FROM "Reservation" WHERE "orderId" LIKE $1`, [`inv-${tag}%`]);
  });

  it("clean system reports no violations", async () => {
    const v = await runInvariants({ pgBase: PG, skipDlq: true });
    expect(v).toEqual([]);
  });

  it("INV1: flags an order stuck in a non-terminal state", async () => {
    await sql(
      "order",
      `INSERT INTO "Order" (id, "userId", status, "totalPrice", "createdAt", "updatedAt")
       VALUES ($1, $2, 'AWAITING_PAYMENT', 100, now(), now())`,
      [randomUUID(), `inv-${tag}`]
    );
    const v = await runInvariants({ pgBase: PG, skipDlq: true });
    expect(v.map((x) => x.invariant)).toContain("INV1_ORDER_TERMINAL");
  });

  it("INV3: flags one order whose reservations split CONSUMED and RELEASED", async () => {
    const orderId = `inv-${tag}-split`;
    for (const status of ["CONSUMED", "RELEASED"]) {
      await sql(
        "inventory",
        `INSERT INTO "Reservation" (id, "orderId", "productId", quantity, status, "expiresAt", "createdAt")
         VALUES ($1, $2, $3, 1, $4, now() + interval '1 hour', now())`,
        [randomUUID(), orderId, `p-${tag}`, status]
      );
    }
    const v = await runInvariants({ pgBase: PG, skipDlq: true });
    expect(v.map((x) => x.invariant)).toContain("INV3_RESERVATION_SPLIT");
  });

  it("INV4: flags an outbox row left unsent", async () => {
    await sql(
      "order",
      `INSERT INTO "Outbox" (id, "aggregateType", "aggregateId", type, version, "traceId", producer, payload, "occurredAt")
       VALUES ($1, 'order', $2, 'order.placed', 1, 't', $3, '{}'::jsonb, now())`,
      [randomUUID(), `inv-${tag}`, `inv-${tag}`]
    );
    const v = await runInvariants({ pgBase: PG, skipDlq: true });
    expect(v.map((x) => x.invariant)).toContain("INV4_OUTBOX_UNSENT");
  });
});
```

`.int.test.ts` because it needs a database — CI's `quality` lane runs with none and excludes that pattern.

- [ ] **Step 3: Run it and confirm it fails**

Run: `PGBASE=postgresql://ecom:ecom@localhost:5433 pnpm vitest run infra/scripts/__tests__/check-invariants.int.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the checker**

```ts
import { Client } from "pg";

export type Violation = { invariant: string; database: string; rows: unknown[] };

export type InvariantOpts = {
  pgBase: string;
  /** Skip the Kafka DLQ invariant (Task 3). Lets the pg-only tests run without a broker. */
  skipDlq?: boolean;
};

type Check = { name: string; database: string; sql: string };

// Every query returns the OFFENDING rows. Zero rows = the invariant holds.
// Deliberately NOT included, because the database already enforces them and a
// check that cannot fail proves nothing: duplicate Payment per orderId
// (Payment.orderId is @unique) and duplicate ProcessedEvent per eventId
// (eventId is the @id). The real risk in both cases is a mishandled duplicate,
// which INV5 catches by looking at the DLQ instead.
const CHECKS: Check[] = [
  {
    name: "INV1_ORDER_TERMINAL",
    database: "order",
    sql: `SELECT id, status FROM "Order" WHERE status IN ('PENDING','AWAITING_PAYMENT')`,
  },
  {
    name: "INV3_RESERVATION_SPLIT",
    database: "inventory",
    sql: `SELECT "orderId"
            FROM "Reservation"
           GROUP BY "orderId"
          HAVING COUNT(*) FILTER (WHERE status = 'CONSUMED') > 0
             AND COUNT(*) FILTER (WHERE status = 'RELEASED') > 0`,
  },
];

// INV4 runs against every outbox-owning database — 7 of them, gateway has none.
const OUTBOX_DATABASES = [
  "hello", "inventory", "order", "payment", "catalog", "notification", "identity",
];

async function query(url: string, sql: string): Promise<unknown[]> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query(sql);
    return r.rows;
  } finally {
    await c.end();
  }
}

export async function runInvariants(opts: InvariantOpts): Promise<Violation[]> {
  const violations: Violation[] = [];

  for (const check of CHECKS) {
    const rows = await query(`${opts.pgBase}/${check.database}`, check.sql);
    if (rows.length > 0)
      violations.push({ invariant: check.name, database: check.database, rows });
  }

  for (const db of OUTBOX_DATABASES) {
    const rows = await query(
      `${opts.pgBase}/${db}`,
      `SELECT id, type, "occurredAt" FROM "Outbox" WHERE "sentAt" IS NULL`
    );
    if (rows.length > 0)
      violations.push({ invariant: "INV4_OUTBOX_UNSENT", database: db, rows });
  }

  return violations;
}
```

- [ ] **Step 5: Run and confirm green**

Run: `PGBASE=postgresql://ecom:ecom@localhost:5433 pnpm vitest run infra/scripts/__tests__/check-invariants.int.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Prove each invariant discriminates**

Delete `CHECKS[0]` (INV1), re-run, confirm only the INV1 test fails. Restore. Repeat for INV3 and for the INV4 loop. Record which test failed each time. **Three invariants, three separate proofs** — if removing one query fails more than its own test, the tests overlap and are not isolating what they claim to.

- [ ] **Step 7: Typecheck, lint, format, commit**

```bash
pnpm -r typecheck && pnpm lint && pnpm format:check
git add infra/scripts/check-invariants.ts infra/scripts/__tests__/check-invariants.int.test.ts package.json pnpm-lock.yaml
git commit -m "feat(infra): invariant checker with the single-database saga invariants"
```

---

### Task 2: Cross-service invariants

**Files:**
- Modify: `infra/scripts/check-invariants.ts`
- Modify: `infra/scripts/__tests__/check-invariants.int.test.ts`

**Interfaces:**
- Consumes: `runInvariants`, `Violation` from Task 1.
- Produces: two additional invariant names — `INV2_CANCELLED_BUT_PAID`, `INV6_CONFIRMED_INCOMPLETE`.

These two need more than one database open at once, which is why they are separate from Task 1's table-driven checks. **They are the only invariants a split-brain outcome trips**, and INV2 is the sharpest "double effects" check in the suite: money taken for an order the customer was told was cancelled.

- [ ] **Step 1: Write the failing tests**

```ts
it("INV2: flags an order CANCELLED while its payment SUCCEEDED", async () => {
  const orderId = randomUUID();
  await sql(
    "order",
    `INSERT INTO "Order" (id, "userId", status, "totalPrice", "createdAt", "updatedAt")
     VALUES ($1, $2, 'CANCELLED', 100, now(), now())`,
    [orderId, `inv-${tag}`]
  );
  await sql(
    "payment",
    `INSERT INTO "Payment" (id, "orderId", amount, status, "createdAt", "updatedAt")
     VALUES ($1, $2, 100, 'SUCCEEDED', now(), now())`,
    [randomUUID(), orderId]
  );
  const v = await runInvariants({ pgBase: PG, skipDlq: true });
  expect(v.map((x) => x.invariant)).toContain("INV2_CANCELLED_BUT_PAID");
});

it("INV6: flags a CONFIRMED order with no SUCCEEDED payment", async () => {
  await sql(
    "order",
    `INSERT INTO "Order" (id, "userId", status, "totalPrice", "createdAt", "updatedAt")
     VALUES ($1, $2, 'CONFIRMED', 100, now(), now())`,
    [randomUUID(), `inv-${tag}`]
  );
  const v = await runInvariants({ pgBase: PG, skipDlq: true });
  expect(v.map((x) => x.invariant)).toContain("INV6_CONFIRMED_INCOMPLETE");
});
```

Extend the `afterAll` cleanup to delete from `payment` too:

```ts
await sql("payment", `DELETE FROM "Payment" WHERE "orderId" IN (SELECT id FROM "Order" WHERE "userId" = $1)`, [`inv-${tag}`]);
```

Order matters — delete payments before orders, or the subselect finds nothing.

- [ ] **Step 2: Run and confirm both fail**

Run: `PGBASE=postgresql://ecom:ecom@localhost:5433 pnpm vitest run infra/scripts/__tests__/check-invariants.int.test.ts`
Expected: FAIL — neither invariant name appears.

- [ ] **Step 3: Implement**

Append to `runInvariants`, before the `return`:

```ts
  // Cross-service: these read two databases, so they cannot be table-driven like CHECKS.
  // Read the id sets and intersect in memory — the databases are separate servers'
  // logical DBs with no cross-database join available.
  const cancelled = (await query(
    `${opts.pgBase}/order`,
    `SELECT id FROM "Order" WHERE status = 'CANCELLED'`
  )) as { id: string }[];
  const confirmed = (await query(
    `${opts.pgBase}/order`,
    `SELECT id FROM "Order" WHERE status = 'CONFIRMED'`
  )) as { id: string }[];
  const succeeded = new Set(
    ((await query(
      `${opts.pgBase}/payment`,
      `SELECT "orderId" FROM "Payment" WHERE status = 'SUCCEEDED'`
    )) as { orderId: string }[]).map((r) => r.orderId)
  );

  const paidButCancelled = cancelled.filter((o) => succeeded.has(o.id));
  if (paidButCancelled.length > 0)
    violations.push({
      invariant: "INV2_CANCELLED_BUT_PAID",
      database: "order+payment",
      rows: paidButCancelled,
    });

  const confirmedUnpaid = confirmed.filter((o) => !succeeded.has(o.id));
  if (confirmedUnpaid.length > 0)
    violations.push({
      invariant: "INV6_CONFIRMED_INCOMPLETE",
      database: "order+payment",
      rows: confirmedUnpaid,
    });
```

- [ ] **Step 4: Run and confirm green**

Run: `PGBASE=postgresql://ecom:ecom@localhost:5433 pnpm vitest run infra/scripts/__tests__/check-invariants.int.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Prove both discriminate**

Delete the `paidButCancelled` push, confirm only the INV2 test fails, restore. Same for INV6. Report both.

- [ ] **Step 6: Typecheck, lint, format, commit**

```bash
pnpm -r typecheck && pnpm lint && pnpm format:check
git add infra/scripts/check-invariants.ts infra/scripts/__tests__/check-invariants.int.test.ts
git commit -m "feat(infra): cross-service invariants for split-brain outcomes"
```

---

### Task 3: DLQ invariant and drain-awareness

**Files:**
- Modify: `infra/scripts/check-invariants.ts`
- Create: `infra/scripts/__tests__/check-invariants-dlq.int.test.ts`

**Interfaces:**
- Consumes: `runInvariants`, `InvariantOpts` from Task 1.
- Produces: `INV5_DLQ_NOT_EMPTY`; `runInvariants` gains `waitForDrainSeconds?: number`.

**INV5 is not a SQL query.** A parked poison message lands in a Kafka topic (`${topic}.dlq`, `packages/shared/src/kafka.ts:178-181`), not a Postgres row. It uses a `kafkajs` admin client — `kafkajs` is already a dependency of `packages/shared` (`^2.2.4`), so no new package.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterAll } from "vitest";
import { Kafka } from "kafkajs";
import { randomUUID } from "crypto";
import { runInvariants } from "../check-invariants";

const PG = process.env.PGBASE ?? "postgresql://ecom:ecom@localhost:5433";
const BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",");
const kafka = new Kafka({ clientId: `inv-test-${randomUUID()}`, brokers: BROKERS });

describe("invariant checker — DLQ (integration, needs kafka)", () => {
  afterAll(async () => {
    // Truncate the topic we dirtied so later runs start clean.
    const admin = kafka.admin();
    await admin.connect();
    const offsets = await admin.fetchTopicOffsets("order.events.dlq");
    await admin.deleteTopicRecords({
      topic: "order.events.dlq",
      partitions: offsets.map((p) => ({ partition: p.partition, offset: p.high })),
    });
    await admin.disconnect();
  });

  it("INV5: flags a message sitting in a DLQ topic", async () => {
    const producer = kafka.producer();
    await producer.connect();
    await producer.send({
      topic: "order.events.dlq",
      messages: [{ key: randomUUID(), value: "not-a-valid-envelope" }],
    });
    await producer.disconnect();

    const v = await runInvariants({ pgBase: PG, brokers: BROKERS });
    const inv5 = v.find((x) => x.invariant === "INV5_DLQ_NOT_EMPTY");
    expect(inv5).toBeDefined();
    expect(inv5!.rows).toContainEqual(
      expect.objectContaining({ topic: "order.events.dlq" })
    );
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `PGBASE=postgresql://ecom:ecom@localhost:5433 pnpm vitest run infra/scripts/__tests__/check-invariants-dlq.int.test.ts`
Expected: FAIL — `INV5_DLQ_NOT_EMPTY` is never produced.

- [ ] **Step 3: Implement the DLQ check and drain-wait**

Add to `InvariantOpts`:

```ts
  brokers?: string[];
  /** Poll until nothing is in flight, or fail reporting what still was. */
  waitForDrainSeconds?: number;
```

```ts
import { Kafka } from "kafkajs";

const DLQ_TOPICS = [
  "hello.events.dlq", "inventory.events.dlq", "order.events.dlq",
  "payment.events.dlq", "catalog.events.dlq", "notification.events.dlq",
  "identity.events.dlq",
];

// Depth = high watermark - low watermark. A truncated topic has high == low and
// reads as empty, which is what reset-dev-topics.sh leaves behind.
async function dlqDepths(brokers: string[]): Promise<{ topic: string; depth: number }[]> {
  const admin = new Kafka({ clientId: "invariant-checker", brokers }).admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const out: { topic: string; depth: number }[] = [];
    for (const topic of DLQ_TOPICS) {
      if (!existing.has(topic)) continue; // never created = never parked
      const parts = await admin.fetchTopicOffsets(topic);
      const depth = parts.reduce((n, p) => n + (Number(p.high) - Number(p.low)), 0);
      if (depth > 0) out.push({ topic, depth });
    }
    return out;
  } finally {
    await admin.disconnect();
  }
}
```

Call it inside `runInvariants` unless `skipDlq`:

```ts
  if (!opts.skipDlq) {
    const depths = await dlqDepths(opts.brokers ?? ["localhost:9092"]);
    if (depths.length > 0)
      violations.push({ invariant: "INV5_DLQ_NOT_EMPTY", database: "kafka", rows: depths });
  }
```

And the drain-wait, at the **top** of `runInvariants`:

```ts
  // INV1 and INV4 are only meaningful once the system has settled. Without this a
  // chaos run fails merely for checking too early, and the suite becomes untrustworthy
  // in exactly the scenario it exists for. A timeout is a REPORTED FAILURE carrying
  // what was still in flight — never a silent pass and never a hang.
  if (opts.waitForDrainSeconds) {
    const deadline = Date.now() + opts.waitForDrainSeconds * 1000;
    for (;;) {
      const inFlight = await inFlightCount(opts.pgBase);
      if (inFlight === 0) break;
      if (Date.now() >= deadline) {
        violations.push({
          invariant: "DRAIN_TIMEOUT",
          database: "order+outboxes",
          rows: [{ inFlight, waitedSeconds: opts.waitForDrainSeconds }],
        });
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
```

with `inFlightCount` alongside it:

```ts
// "In flight" = the two things that make INV1 and INV4 premature: an order that has
// not settled, and an outbox row the relay has not published. Both must be zero
// before those invariants mean anything.
async function inFlightCount(pgBase: string): Promise<number> {
  const orders = (await query(
    `${pgBase}/order`,
    `SELECT count(*)::int AS n FROM "Order" WHERE status IN ('PENDING','AWAITING_PAYMENT')`
  )) as { n: number }[];

  let unsent = 0;
  for (const db of OUTBOX_DATABASES) {
    const r = (await query(
      `${pgBase}/${db}`,
      `SELECT count(*)::int AS n FROM "Outbox" WHERE "sentAt" IS NULL`
    )) as { n: number }[];
    unsent += r[0].n;
  }
  return orders[0].n + unsent;
}
```

`count(*)` returns a bigint, which `pg` hands back as a **string** — the `::int` cast is what
makes the arithmetic above numeric rather than string concatenation, which would silently never
reach zero.

- [ ] **Step 4: Run and confirm green**

Run: `PGBASE=postgresql://ecom:ecom@localhost:5433 pnpm vitest run infra/scripts/__tests__/check-invariants-dlq.int.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove it discriminates, and prove the drain-timeout reports**

Two checks:
1. Delete the `dlqDepths` call, re-run, confirm the INV5 test fails. Restore.
2. Seed a permanently-unsent outbox row, call with `waitForDrainSeconds: 2`, and confirm a `DRAIN_TIMEOUT` violation is returned **with a non-zero `inFlight` count** — not a hang, not a pass. Clean the row up afterwards.

The second is the one that matters: a drain-wait that silently gives up looks identical to a clean system.

- [ ] **Step 6: Typecheck, lint, format, commit**

```bash
pnpm -r typecheck && pnpm lint && pnpm format:check
git add infra/scripts/check-invariants.ts infra/scripts/__tests__/check-invariants-dlq.int.test.ts
git commit -m "feat(infra): DLQ invariant via kafka admin, plus drain-awareness"
```

---

### Task 4: The k6 checkout script

**Files:**
- Create: `k6/checkout.js`
- Create: `k6/README.md`

**Interfaces:**
- Produces: a k6 script exiting non-zero when any SLO threshold is breached.

- [ ] **Step 1: Write the script**

```js
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://gateway:8000";
const PRODUCT_ID = __ENV.PRODUCT_ID;
const POLL_MS = 250; // stated, not incidental — see thresholds note below

// The saga's duration lives in relay polls and broker hops, none of which appear
// in any single HTTP call, so http_req_duration cannot measure it.
const sagaDuration = new Trend("saga_duration", true);

export const options = {
  vus: Number(__ENV.VUS || 5),
  duration: __ENV.DURATION || "1m",
  thresholds: {
    http_req_duration: ["p(95)<500"],
    saga_duration: ["p(99)<5000"],
    http_req_failed: ["rate<0.01"],
  },
};

export function setup() {
  if (!PRODUCT_ID) throw new Error("PRODUCT_ID is required — seed inventory stock first, see k6/README.md");
  // Fail fast on missing stock. Without this the run "succeeds" with every order
  // CANCELLED for insufficient inventory, and reports a business failure as though
  // it were a latency result — a green threshold on a run that tested nothing.
  const probe = http.get(`${BASE}/products/${PRODUCT_ID}`);
  if (probe.status !== 200)
    throw new Error(`PRODUCT_ID ${PRODUCT_ID} not resolvable via the gateway (status ${probe.status})`);
  return {};
}

function csrfFrom(jar) {
  const c = jar.cookiesForURL(BASE);
  return c["XSRF-TOKEN"] ? c["XSRF-TOKEN"][0] : "";
}

export default function () {
  const jar = http.cookieJar();
  const email = `k6-${__VU}-${__ITER}-${Date.now()}@example.test`;
  const json = { "Content-Type": "application/json" };

  // register requires `name` — not just email+password.
  http.post(`${BASE}/auth/register`,
    JSON.stringify({ email, password: "password123", name: "k6" }), { headers: json });
  http.post(`${BASE}/auth/login`,
    JSON.stringify({ email, password: "password123" }), { headers: json });

  // Every mutation needs the double-submit CSRF header.
  const mut = { ...json, "x-csrf-token": csrfFrom(jar) };

  // The cart is its own gateway mount — /cart, not /orders/cart.
  http.post(`${BASE}/cart/items`,
    JSON.stringify({ productId: PRODUCT_ID, quantity: 1 }), { headers: mut });

  const placed = http.post(`${BASE}/orders`, JSON.stringify({}), { headers: mut });
  if (!check(placed, { "order placed": (r) => r.status === 201 || r.status === 200 })) return;

  const orderId = placed.json("orderId");
  const started = Date.now();
  for (;;) {
    const r = http.get(`${BASE}/orders/${orderId}`, { headers: json });
    const status = r.json("status");
    if (status === "CONFIRMED" || status === "CANCELLED") {
      sagaDuration.add(Date.now() - started);
      break;
    }
    if (Date.now() - started > 30000) break; // give up; the threshold will show it
    sleep(POLL_MS / 1000);
  }
}
```

- [ ] **Step 2: Seed stock and run it**

```bash
PID=$(curl -s "http://localhost:8000/products?limit=1" | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
docker exec ecom-platform-postgres-1 psql -U ecom -d inventory -c \
  "INSERT INTO \"Inventory\" (\"productId\", available, \"updatedAt\") VALUES ('$PID', 100000, now())
   ON CONFLICT (\"productId\") DO UPDATE SET available=100000, \"updatedAt\"=now();"
docker run --rm --network ecom-platform_default -v "$PWD/k6:/scripts" \
  -e PRODUCT_ID="$PID" grafana/k6:0.55.0 run /scripts/checkout.js
```

`Inventory.updatedAt` is NOT NULL with no default — a bare INSERT fails.

Expected: exits **0**, and prints all three thresholds as passed.

- [ ] **Step 3: Prove the thresholds actually gate the exit code**

Re-run with `--env` overriding nothing but adding `-e K6_THRESHOLD_TEST=1`… simpler and definitive: temporarily change `http_req_duration` to `["p(95)<1"]`, re-run, and confirm k6 **exits non-zero** and names the breached threshold. Restore.

Without this, "k6 meets the SLOs" is a claim about a script nobody proved can fail — the exact defect class this phase keeps hitting.

- [ ] **Step 4: Cross-validate against the server-side metric**

7b already records `saga_duration_seconds` server-side after commit, with sub-millisecond precision. Query Prometheus for the same window:

```bash
curl -s --get 'http://localhost:9091/api/v1/query' \
  --data-urlencode 'query=histogram_quantile(0.99, sum by (le) (rate(saga_duration_seconds_bucket[5m])))'
```

Compare to k6's reported `saga_duration` p99. **They must agree within the 250 ms poll interval.** A larger gap means the k6 harness is measuring the wrong thing, and that comparison is the only thing standing between a plausible number and a correct one. Record both in `k6/README.md`.

- [ ] **Step 5: Write `k6/README.md`**

Covers: the seed step, the run command, what each threshold means, the cross-validation above, and — stated plainly — that these numbers are a **same-machine regression signal, not a benchmark**, because they come from one laptop running 8 services and two brokers in containers.

- [ ] **Step 6: Lint, format, commit**

```bash
pnpm lint && pnpm format:check
git add k6/checkout.js k6/README.md
git commit -m "feat(k6): checkout load script with the SLOs as thresholds"
```

---

### Task 5: Prometheus SLO burn-rate rules

**Files:**
- Create: `infra/prometheus/rules/slo.yml`
- Modify: `infra/prometheus/prometheus.yml`
- Modify: `docker-compose.example.yml`

**Interfaces:**
- Produces: alert names `CheckoutErrorBudgetFastBurn`, `CheckoutErrorBudgetSlowBurn`, `CheckoutLatencySLOBreach`.

`infra/prometheus/prometheus.yml` currently has only `global` and `scrape_configs` — no `rule_files` key. Prometheus's container also needs the rules directory mounted.

- [ ] **Step 1: Write the rules**

```yaml
groups:
  - name: checkout-slo
    rules:
      # Windows are scaled DOWN from the textbook 5m/1h and 30m/6h. Those are sized
      # for continuous production traffic; this stack only sees load while someone is
      # running k6 or chaos, so a 1h window could never be moved by any outage anyone
      # would sit through — the alerts would ship unvalidated, which is the exact
      # "untested alert is decoration" outcome 7b deferred them here to avoid.
      # The two-window structure, which is the part worth learning, is preserved.
      - alert: CheckoutErrorBudgetFastBurn
        expr: |
          (sum(rate(http_requests_total{status=~"5.."}[1m])) / sum(rate(http_requests_total[1m]))) > (14.4 * 0.01)
          and
          (sum(rate(http_requests_total{status=~"5.."}[15m])) / sum(rate(http_requests_total[15m]))) > (14.4 * 0.01)
        for: 30s
        labels: { severity: page }
        annotations:
          summary: "Checkout error budget burning fast (14.4x)"

      - alert: CheckoutErrorBudgetSlowBurn
        expr: |
          (sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))) > (6 * 0.01)
          and
          (sum(rate(http_requests_total{status=~"5.."}[1h])) / sum(rate(http_requests_total[1h]))) > (6 * 0.01)
        for: 2m
        labels: { severity: ticket }
        annotations:
          summary: "Checkout error budget burning steadily (6x)"

      - alert: CheckoutLatencySLOBreach
        expr: histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m]))) > 0.5
        for: 5m
        labels: { severity: ticket }
        annotations:
          summary: "Checkout p95 latency over the 500ms SLO"
```

- [ ] **Step 2: Wire the rules in**

In `infra/prometheus/prometheus.yml`, above `scrape_configs`:

```yaml
rule_files:
  - /etc/prometheus/rules/*.yml
```

In `docker-compose.example.yml`, add to prometheus's `volumes`:

```yaml
      - ./infra/prometheus/rules:/etc/prometheus/rules:ro
```

- [ ] **Step 3: Validate the syntax**

```bash
docker run --rm --network none --entrypoint promtool \
  -v "$PWD/infra/prometheus/rules:/rules:ro" prom/prometheus:v3.13.1 check rules /rules/slo.yml
```

Expected: `SUCCESS: 3 rules found`.

- [ ] **Step 4: Confirm Prometheus loads them**

Restart Prometheus, then:

```bash
curl -s http://localhost:9091/api/v1/rules | python3 -c "
import sys,json
g=json.load(sys.stdin)['data']['groups']
print([r['name'] for gr in g for r in gr['rules']])"
```

Expected: all three alert names. A rules file that is syntactically valid but never loaded is the failure this step exists to catch — `promtool` passing proves nothing about the mount.

- [ ] **Step 5: Commit**

```bash
pnpm format:check
git add infra/prometheus/rules/slo.yml infra/prometheus/prometheus.yml docker-compose.example.yml
git commit -m "feat(infra): SLO burn-rate alert rules, scaled to this stack's traffic"
```

---

### Task 6: Chaos scenarios C1–C3

**Files:**
- Create: `infra/scripts/chaos.sh`
- Create: `infra/scripts/drive-checkouts.ts`

**Interfaces:**
- Consumes: `runInvariants` (Tasks 1–3).
- Produces: `chaos.sh <scenario>` where scenario is `kafka`, `inventory`, `poison`, or `order` (Task 7).

`drive-checkouts.ts` is a small traffic generator: it registers, logs in, and places N orders against the gateway, used by scenarios that need in-flight sagas. It is separate from k6 because chaos needs orders placed at a controlled rate while the script does other things, not a load profile.

- [ ] **Step 1: Write `drive-checkouts.ts`**

```ts
// Places N orders against the gateway at a controlled rate. Separate from k6 because
// chaos needs a steady trickle while the script does other things, not a load profile.
const BASE = process.env.BASE_URL ?? "http://localhost:8000";
const COUNT = Number(process.env.COUNT ?? 20);
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 500);
const PRODUCT_ID = process.env.PRODUCT_ID;

if (!PRODUCT_ID) throw new Error("PRODUCT_ID required — seed inventory stock first");

function cookieHeader(jar: Map<string, string>): string {
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}
function absorb(jar: Map<string, string>, res: Response): void {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
}

async function main() {
  const jar = new Map<string, string>();
  const email = `chaos-${Date.now()}@example.test`;
  const json = { "content-type": "application/json" };

  // register requires `name`, not just email+password.
  await fetch(`${BASE}/auth/register`, {
    method: "POST", headers: json,
    body: JSON.stringify({ email, password: "password123", name: "chaos" }),
  });
  absorb(jar, await fetch(`${BASE}/auth/login`, {
    method: "POST", headers: json,
    body: JSON.stringify({ email, password: "password123" }),
  }));

  // Double-submit CSRF: echo the XSRF-TOKEN cookie into the header.
  const mut = () => ({ ...json, cookie: cookieHeader(jar), "x-csrf-token": jar.get("XSRF-TOKEN") ?? "" });

  for (let i = 0; i < COUNT; i++) {
    try {
      // The cart is its own gateway mount — /cart, not /orders/cart.
      await fetch(`${BASE}/cart/items`, {
        method: "POST", headers: mut(),
        body: JSON.stringify({ productId: PRODUCT_ID, quantity: 1 }),
      });
      const r = await fetch(`${BASE}/orders`, { method: "POST", headers: mut(), body: "{}" });
      // Errors are EXPECTED mid-outage and must not stop the driver — an error rate
      // needs a denominator, and a driver that quits on the first 5xx flattens it.
      console.log(`${i} ${r.status}`);
    } catch (e) {
      console.log(`${i} ERR ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

void main();
```

- [ ] **Step 2: Write the three scenarios**

```bash
#!/usr/bin/env bash
# Chaos scenarios. Each: drive traffic -> break something -> restore -> wait for
# drain -> assert the invariants. A scenario "passes" only if the checker is clean.
set -euo pipefail
SCENARIO="${1:?usage: chaos.sh kafka|inventory|poison|order}"
COMPOSE="docker compose -f docker-compose.example.yml"
PGBASE="${PGBASE:-postgresql://ecom:ecom@localhost:5433}"

drive() { COUNT="${1:-20}" INTERVAL_MS="${2:-500}" npx tsx infra/scripts/drive-checkouts.ts & DRIVER=$!; }
settle() { wait "$DRIVER" 2>/dev/null || true; }
assert_clean() {
  PGBASE="$PGBASE" npx tsx -e '
    import { runInvariants } from "./infra/scripts/check-invariants";
    const v = await runInvariants({ pgBase: process.env.PGBASE!, waitForDrainSeconds: 60 });
    if (v.length) { console.error(JSON.stringify(v, null, 2)); process.exit(1); }
    console.log("invariants clean");
  '
}

case "$SCENARIO" in
  kafka)      # The roadmap's Done-when case.
    drive 20 500; sleep 3
    $COMPOSE stop kafka; sleep 15; $COMPOSE start kafka
    settle; assert_clean ;;
  inventory)  # NOTE: RESERVATION_TTL_MS defaults to 900_000 (15 min), so a 15s outage
              # exercises the DELAY regime, not compensation. Reaching compensation
              # needs inventory restarted with a small TTL — see the runbook.
    drive 20 500; sleep 3
    $COMPOSE stop inventory; sleep 15; $COMPOSE start inventory
    settle; assert_clean ;;
  poison)     # Parks without stalling the partition — the Phase 3b parse fix.
    npx tsx infra/scripts/publish-poison.ts
    drive 1 0; settle
    # The valid order placed AFTER the poison message must still reach a terminal
    # state. That is what distinguishes "parked" from "stalled partition"; a suite
    # that only checked the DLQ count would pass against a wedged consumer.
    #
    # This scenario expects EXACTLY ONE violation — INV5, reporting the one message
    # we parked on purpose. It must assert that shape, not swallow the result:
    # `assert_clean || true` would make the scenario pass no matter what happened,
    # which is the "check that cannot fail" defect this plan's Global Constraint 1
    # exists to prevent.
    PGBASE="$PGBASE" npx tsx -e '
      import { runInvariants } from "./infra/scripts/check-invariants";
      const v = await runInvariants({ pgBase: process.env.PGBASE!, waitForDrainSeconds: 60 });
      const names = v.map((x) => x.invariant).sort();
      // Exactly one violation, and it is the DLQ one. Anything else — a stalled
      // partition leaving orders non-terminal, an unsent outbox row — fails here.
      if (names.length !== 1 || names[0] !== "INV5_DLQ_NOT_EMPTY") {
        console.error("expected exactly [INV5_DLQ_NOT_EMPTY], got:", JSON.stringify(v, null, 2));
        process.exit(1);
      }
      const depths = v[0].rows as { topic: string; depth: number }[];
      const total = depths.reduce((n, d) => n + d.depth, 0);
      if (total !== 1) { console.error(`expected exactly 1 parked message, got ${total}`); process.exit(1); }
      console.log("poison parked, partition kept moving");
    '
    ;;
esac
```

`publish-poison.ts` is a four-line kafkajs producer sending `"not-a-valid-envelope"` to
`order.events`.

- [ ] **Step 3: Run all three**

Each must end with the invariant checker clean (except `poison`, which expects exactly one DLQ entry — the checker's INV5 violation is the *expected* result there, and the scenario asserts the count rather than emptiness).

- [ ] **Step 4: Prove the poison scenario discriminates**

The scenario's value is the "partition keeps moving" assertion. Confirm it would fail if the valid order never processed — temporarily point the valid order at a stopped consumer, observe the failure, restore. If that cannot be arranged cheaply, state so and explain what the assertion does and does not cover rather than claiming more.

- [ ] **Step 5: Lint, format, commit**

```bash
pnpm lint && pnpm format:check
git add infra/scripts/chaos.sh infra/scripts/drive-checkouts.ts
git commit -m "feat(infra): chaos scenarios for broker loss, service loss and poison messages"
```

---

### Task 7: Chaos C4 and alert validation

**Files:**
- Modify: `infra/scripts/chaos.sh`

**Interfaces:**
- Consumes: the alert names from Task 5, `drive-checkouts.ts` from Task 6.

**C4 is the only scenario that produces gateway-visible errors.** The gateway proxies `order`, `catalog` and `payment` (`services/gateway/src/app.ts:216-237`) — **there is no `/inventory` mount** — so C1's Kafka stop, C2's inventory stop and C3's poison message move no gateway error counter at all. Stopping `order` makes the gateway return 5xx from `proxy.ts:92-103` (503 open circuit / 504 timeout / 502 unreachable, all matching `status=~"5.."`).

- [ ] **Step 1: Add the `order` scenario**

```bash
  order)      # The ONLY scenario that produces gateway-visible errors, and therefore
              # the only one that can validate the burn-rate alerts.
    # 280 orders at 500ms ~= 140s of continuous traffic. The driver must span the
    # WHOLE outage: an error rate needs a denominator, and a driver that stops when
    # requests start failing flattens the rate instead of climbing it — a failure
    # mode indistinguishable from a broken rule.
    drive 280 500; sleep 5
    $COMPOSE stop order
    sleep 120                      # must outlast the 15m window's ability to move
    $COMPOSE start order
    settle; assert_clean ;;

Two properties are load-bearing and each has a failure mode that looks like a broken rule:
- **The outage must outlast the long window.** Fast-burn needs both 1m and 15m breaching; a 15-second blip cannot move a 15m rate.
- **Traffic must keep flowing during the outage.** An error *rate* needs a denominator. If the driver stops when requests start failing, the rate goes flat instead of climbing and the alert never fires.

- [ ] **Step 2: Assert the alerts fired**

```bash
curl -s http://localhost:9091/api/v1/alerts | python3 -c "
import sys,json
a=[x['labels']['alertname'] for x in json.load(sys.stdin)['data']['alerts'] if x['state']=='firing']
print('firing:', a)
assert 'CheckoutErrorBudgetFastBurn' in a, 'fast-burn did not fire'
"
```

- [ ] **Step 3: Run it and record what actually fired**

Expected: `CheckoutErrorBudgetFastBurn` firing. If only the latency alert fires, or none does, **report that** — the number that matters is what fired, not what was hoped for. An alert that does not fire under a real outage is the finding this task exists to produce.

- [ ] **Step 4: Lint, format, commit**

```bash
pnpm lint && pnpm format:check
git add infra/scripts/chaos.sh
git commit -m "feat(infra): chaos scenario that stops a proxied service and validates the alerts"
```

---

### Task 8: Runbook and roadmap correction

**Files:**
- Create: `docs/runbooks/phase-7d-verification-demo.md`
- Modify: `docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md`

- [ ] **Step 1: Write the runbook**

Matching the existing `phase-N-<topic>-demo.md` naming. Covers: running k6 and reading its output including the cross-validation against `saga_duration_seconds`; running each chaos scenario and what a pass looks like; the two `RESERVATION_TTL_MS` regimes for the inventory scenario; what each alert means and what to do; and B3's caveat that the numbers are a same-machine regression signal.

- [ ] **Step 2: Correct the roadmap prose**

Phase 7's Scope-in still lists `ProcessedEvent` retention (shipped in 7a via `startLedgerPruner`, wired at 10 call sites) and still bundles the two lesson items into 7d. Restate 7d as **k6 + chaos + SLO alerts + runbooks**, and give the two lesson items their own backlog row so they are deferred visibly rather than dropped.

- [ ] **Step 3: Verify nothing else contradicts**

Run: `grep -n "7a\|7b\|7c\|7d" docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md`
Every remaining mention must match the four-slice model. This same drift has needed correcting in 7b and 7c — check the absorption map rows too, not just the prose.

- [ ] **Step 4: Commit**

```bash
pnpm format:check
git add docs/runbooks/phase-7d-verification-demo.md docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md
git commit -m "docs(7d): verification runbook and Phase 7 prose correction"
```

---

### Task 9: End-to-end acceptance

**Files:**
- Create: `.superpowers/sdd/2026-07-29-phase-7d-verification/acceptance.md`

The spec's §I is the acceptance test. The equivalent step found a real defect in each of the two preceding slices — a dashboard panel that rendered "No data" for every healthy service in 7b, and a consumer-span hierarchy bug in 7c. Expect it to find something.

- [ ] **Step 1: Clean slate**

```bash
bash infra/scripts/reset-dev-topics.sh
docker compose -f docker-compose.example.yml --profile app up -d
```

Also clear the stale reservations noted in the 7c handover — inventory's sweeper is permanently retrying 37 rows left by earlier manual runs, which inflates the idle span rate and adds noise to any measurement here.

- [ ] **Step 2: Run k6 and record the numbers**

All three thresholds must pass and the process must exit 0. Record k6's `saga_duration` p99 beside Prometheus's `saga_duration_seconds` p99 for the same window.

- [ ] **Step 3: Run all four chaos scenarios**

Each must end with the invariant checker clean (`poison` expects exactly one DLQ entry). Record the checker's output for each.

- [ ] **Step 4: Confirm Phase 7's Done-when**

Specifically: killing Kafka mid-saga lost nothing and duplicated nothing — INV1 through INV6 all clean after the `kafka` scenario. That sentence is the phase's headline criterion.

- [ ] **Step 5: Record what fired, and what did not**

Alerts observed firing during C4, with the ones that did not fire named explicitly and the reason given if known.

- [ ] **Step 6: Full regression**

```bash
pnpm -r typecheck && pnpm lint && pnpm format:check
for s in hello inventory order payment catalog notification identity gateway; do
  DATABASE_URL="postgresql://ecom:ecom@localhost:5433/$s" pnpm vitest run "services/$s"
done
pnpm vitest run packages infra
```

Payment additionally needs `PAYMENT_WEBHOOK_SECRET=test-secret`; notification needs `SMTP_PORT=1026 MAILPIT_API=http://localhost:8026`.

- [ ] **Step 7: Commit the evidence**

```bash
git add .superpowers/sdd/2026-07-29-phase-7d-verification/acceptance.md
git commit -m "docs(7d): verification acceptance evidence"
```

---

## Notes for the executor

**Dependency order:** 1 → 2 → 3 are sequential (same file). 4 and 5 are independent of each other and of 1–3. 6 depends on 1–3. 7 depends on 5 and 6. 8 is independent. 9 depends on everything.

**The discrimination proofs** are Task 1 Step 6, Task 2 Step 5, Task 3 Step 5, Task 4 Step 3, Task 6 Step 4. Each exists because the naive version of that check passes against a broken implementation. If one cannot be made to fail, that is a finding to report — not a formality to wave through.

**When a task's brief and the Global Constraints disagree, the constraints win.** Both 7a and 7b had plan snippets that omitted a guard the constraints already required, and both were adjudicated that way.
