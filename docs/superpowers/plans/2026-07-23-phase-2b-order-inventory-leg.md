# Phase 2b · Order (Inventory-leg consumer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Order service its first Kafka consumer so it reacts to Inventory's reservation result, driving `PENDING→AWAITING_PAYMENT` / `PENDING→CANCELLED` (emitting `OrderCancelled`), guarded by a same-transaction `ProcessedEvent` dedup ledger.

**Architecture:** A pure transition core (`nextStatus`) + a domain core over a tx-bound port (`applyInventoryResult`) — mirroring `services/inventory`'s `reserve.ts` — orchestrated by a thin `consumer.ts` that opens one `prisma.$transaction` per event. The order is loaded **before** the ledger is touched, so unknown-order events stay replay-recoverable. Stops honestly at `AWAITING_PAYMENT`; Payment (Phase 3) closes the loop.

**Tech Stack:** TypeScript, Express, Prisma (custom client output `./generated/prisma`), KafkaJS via `@ecom/shared` wrappers, zod via `@ecom/contracts`, Vitest + supertest.

**Reference spec:** `docs/superpowers/specs/2026-07-23-phase-2b-order-inventory-leg-design.md`

## Global Constraints

- **No contract change** — consume `INVENTORY_RESERVED` / `INVENTORY_RESERVATION_FAILED`, emit `ORDER_CANCELLED`; all already exist in `packages/contracts`.
- **No new env** — config stays `DATABASE_URL`, `KAFKA_BROKERS`, `PORT`, `LOG_LEVEL`. No Redis.
- **Consumer group** = `"order-consumers"`; **topic consumed** = `"inventory.events"`.
- **Prisma convention** — PascalCase models, camelCase fields, no `@map`. Migrations via CLI only (`prisma migrate dev`), never hand-edit `prisma/migrations/`.
- **Money** is integer minor units (already so; this slice adds none).
- **Logging** — ids/codes only, never PII (`orderId`, `eventId`, `type`, `outcome`, `traceId`). Enforced by the `sensitive-logging` hook.
- **Idempotency order is load-bearing** — `loadOrderStatus` runs **before** `markProcessed`; an `UNKNOWN_ORDER` event is acked **without** a ledger row. This deliberately diverges from `inventory/reserve.ts` (which marks-processed first) because an Order must pre-exist its inventory result. Do not "fix" it back.
- **Graceful-shutdown teardown order** — HTTP server drains first, then `consumer.disconnect` → `relay.stop` → `producer.disconnect` → `prisma.$disconnect`.

---

## File Structure

- **Create** `services/order/src/transition.ts` — `OrderStatus`, pure `nextStatus`, `TransitionTx` port interface, `applyInventoryResult` domain core.
- **Create** `services/order/src/consumer.ts` — `handleInventoryEvent(env)`: parse → one `$transaction` → `applyInventoryResult`.
- **Create** `services/order/src/__tests__/transition.unit.test.ts` — pure/core unit tests (fake port).
- **Create** `services/order/src/__tests__/consumer.int.test.ts` — handler against real Postgres.
- **Create** `services/order/src/__tests__/inventory-leg.e2e.test.ts` — real Kafka round-trip.
- **Modify** `services/order/prisma/schema.prisma` — add `ProcessedEvent` model.
- **Modify** `services/order/src/tx-adapters.ts` — add `transitionTx(tx, traceId)`.
- **Modify** `services/order/src/main.ts` — wire the consumer + shutdown.
- **Generated** `services/order/prisma/migrations/<ts>_add_processed_event/` — via CLI (do not edit).

No CI change: `.github/workflows/ci.yml` already runs `prisma migrate deploy` + `pnpm vitest run services/order` (int/e2e) and the unit job runs `transition.unit.test.ts` automatically.

---

### Task 1: Transition core (pure `nextStatus` + `applyInventoryResult` over a port)

**Files:**
- Create: `services/order/src/transition.ts`
- Test: `services/order/src/__tests__/transition.unit.test.ts`

**Interfaces:**
- Consumes: `INVENTORY_RESERVED`, `INVENTORY_RESERVATION_FAILED`, `ORDER_CANCELLED` from `@ecom/contracts`.
- Produces (later tasks rely on these exact signatures):
  - `type OrderStatus = "PENDING" | "AWAITING_PAYMENT" | "CANCELLED" | "CONFIRMED"`
  - `function nextStatus(current: string, eventType: string): OrderStatus | null`
  - `interface TransitionTx { loadOrderStatus(orderId: string): Promise<string | null>; markProcessed(eventId: string, type: string): Promise<boolean>; setStatus(orderId: string, status: OrderStatus): Promise<void>; enqueue(type: string, orderId: string, payload: unknown): Promise<void> }`
  - `type ApplyOutcome = "UNKNOWN_ORDER" | "DUPLICATE" | "NO_OP" | "AWAITING_PAYMENT" | "CANCELLED"`
  - `function applyInventoryResult(tx: TransitionTx, p: { eventId: string; type: string; orderId: string }): Promise<ApplyOutcome>`

- [ ] **Step 1: Write the failing unit test**

Create `services/order/src/__tests__/transition.unit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { nextStatus, applyInventoryResult, type TransitionTx } from "../transition";
import { INVENTORY_RESERVED, INVENTORY_RESERVATION_FAILED, ORDER_CANCELLED } from "@ecom/contracts";

function fakeTx(initialStatus: string | null) {
  const processed = new Set<string>();
  const emitted: Array<{ type: string; orderId: string; payload: unknown }> = [];
  let status = initialStatus;
  const tx: TransitionTx = {
    async loadOrderStatus() {
      return status;
    },
    async markProcessed(eventId) {
      if (processed.has(eventId)) return false;
      processed.add(eventId);
      return true;
    },
    async setStatus(_orderId, s) {
      status = s;
    },
    async enqueue(type, orderId, payload) {
      emitted.push({ type, orderId, payload });
    },
  };
  return { tx, emitted, processed, statusNow: () => status };
}

describe("nextStatus (pure transition table)", () => {
  it("PENDING + reserved -> AWAITING_PAYMENT", () => {
    expect(nextStatus("PENDING", INVENTORY_RESERVED)).toBe("AWAITING_PAYMENT");
  });
  it("PENDING + failed -> CANCELLED", () => {
    expect(nextStatus("PENDING", INVENTORY_RESERVATION_FAILED)).toBe("CANCELLED");
  });
  it("guards every other (status, event) to null", () => {
    expect(nextStatus("AWAITING_PAYMENT", INVENTORY_RESERVED)).toBeNull();
    expect(nextStatus("CANCELLED", INVENTORY_RESERVATION_FAILED)).toBeNull();
    expect(nextStatus("PENDING", "something.else")).toBeNull();
  });
});

describe("applyInventoryResult", () => {
  it("reserved on a PENDING order -> AWAITING_PAYMENT, ledgered, no emit", async () => {
    const f = fakeTx("PENDING");
    const outcome = await applyInventoryResult(f.tx, {
      eventId: "e1",
      type: INVENTORY_RESERVED,
      orderId: "o1",
    });
    expect(outcome).toBe("AWAITING_PAYMENT");
    expect(f.statusNow()).toBe("AWAITING_PAYMENT");
    expect(f.processed.has("e1")).toBe(true);
    expect(f.emitted).toEqual([]);
  });

  it("failed on a PENDING order -> CANCELLED and emits OrderCancelled", async () => {
    const f = fakeTx("PENDING");
    const outcome = await applyInventoryResult(f.tx, {
      eventId: "e2",
      type: INVENTORY_RESERVATION_FAILED,
      orderId: "o2",
    });
    expect(outcome).toBe("CANCELLED");
    expect(f.statusNow()).toBe("CANCELLED");
    expect(f.emitted).toEqual([
      { type: ORDER_CANCELLED, orderId: "o2", payload: { orderId: "o2" } },
    ]);
  });

  it("unknown order -> UNKNOWN_ORDER without ledgering (replay-safe)", async () => {
    const f = fakeTx(null);
    const outcome = await applyInventoryResult(f.tx, {
      eventId: "e3",
      type: INVENTORY_RESERVED,
      orderId: "missing",
    });
    expect(outcome).toBe("UNKNOWN_ORDER");
    expect(f.processed.size).toBe(0); // NOT ledgered
    expect(f.emitted).toEqual([]);
  });

  it("dedupes a redelivered event (second call is DUPLICATE, no re-effect)", async () => {
    const f = fakeTx("PENDING");
    await applyInventoryResult(f.tx, { eventId: "e4", type: INVENTORY_RESERVED, orderId: "o4" });
    const outcome = await applyInventoryResult(f.tx, {
      eventId: "e4",
      type: INVENTORY_RESERVED,
      orderId: "o4",
    });
    expect(outcome).toBe("DUPLICATE");
    expect(f.statusNow()).toBe("AWAITING_PAYMENT"); // unchanged
    expect(f.emitted).toEqual([]);
  });

  it("out-of-order guard: reserved on a CANCELLED order -> NO_OP", async () => {
    const f = fakeTx("CANCELLED");
    const outcome = await applyInventoryResult(f.tx, {
      eventId: "e5",
      type: INVENTORY_RESERVED,
      orderId: "o5",
    });
    expect(outcome).toBe("NO_OP");
    expect(f.statusNow()).toBe("CANCELLED");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run services/order/src/__tests__/transition.unit.test.ts`
Expected: FAIL — `Failed to resolve import "../transition"` / `nextStatus is not a function`.

- [ ] **Step 3: Write the implementation**

Create `services/order/src/transition.ts`:

```ts
import {
  INVENTORY_RESERVED,
  INVENTORY_RESERVATION_FAILED,
  ORDER_CANCELLED,
} from "@ecom/contracts";

export type OrderStatus = "PENDING" | "AWAITING_PAYMENT" | "CANCELLED" | "CONFIRMED";

// Pure transition table. Only PENDING is a live source this slice; every other
// (status, event) pair — a late, duplicate, or out-of-order event — returns null
// so the caller no-ops instead of corrupting state.
export function nextStatus(current: string, eventType: string): OrderStatus | null {
  if (current === "PENDING" && eventType === INVENTORY_RESERVED) return "AWAITING_PAYMENT";
  if (current === "PENDING" && eventType === INVENTORY_RESERVATION_FAILED) return "CANCELLED";
  return null;
}

export interface TransitionTx {
  loadOrderStatus(orderId: string): Promise<string | null>; // null => no such order
  markProcessed(eventId: string, type: string): Promise<boolean>; // false => already processed
  setStatus(orderId: string, status: OrderStatus): Promise<void>;
  enqueue(type: string, orderId: string, payload: unknown): Promise<void>;
}

export type ApplyOutcome =
  | "UNKNOWN_ORDER"
  | "DUPLICATE"
  | "NO_OP"
  | "AWAITING_PAYMENT"
  | "CANCELLED";

// Domain core over a tx-bound port (mirrors inventory/reserve.ts). Order of
// operations is load-bearing: load the order BEFORE the ledger so an unknown
// order is acked without a ProcessedEvent row and stays replay-recoverable.
export async function applyInventoryResult(
  tx: TransitionTx,
  p: { eventId: string; type: string; orderId: string }
): Promise<ApplyOutcome> {
  const status = await tx.loadOrderStatus(p.orderId);
  if (status === null) return "UNKNOWN_ORDER"; // not ledgered — replay-safe

  const fresh = await tx.markProcessed(p.eventId, p.type);
  if (!fresh) return "DUPLICATE"; // at-least-once redelivery

  const next = nextStatus(status, p.type);
  if (next === null) return "NO_OP"; // ledgered; late/out-of-order guard

  await tx.setStatus(p.orderId, next);
  if (next === "CANCELLED") {
    await tx.enqueue(ORDER_CANCELLED, p.orderId, { orderId: p.orderId });
  }
  return next;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run services/order/src/__tests__/transition.unit.test.ts`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @ecom/order typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add services/order/src/transition.ts services/order/src/__tests__/transition.unit.test.ts
git commit -m "feat(order): transition core — nextStatus + applyInventoryResult (unit-tested)"
```

---

### Task 2: Persistence — `ProcessedEvent` model + `transitionTx` port adapter

**Files:**
- Modify: `services/order/prisma/schema.prisma` (append after the `Outbox` model)
- Modify: `services/order/src/tx-adapters.ts`
- Generated: `services/order/prisma/migrations/<ts>_add_processed_event/` (CLI, do not edit)

**Interfaces:**
- Consumes: `TransitionTx` from `./transition` (Task 1).
- Produces: `function transitionTx(tx: Prisma.TransactionClient, traceId: string): TransitionTx`.

- [ ] **Step 1: Add the `ProcessedEvent` model**

Append to `services/order/prisma/schema.prisma` (after the `Outbox` model, matching `services/inventory` exactly):

```prisma
// Dedup ledger for at-least-once Kafka delivery. First Order consumer needs it;
// reused by every later consumer (payment results, catalog projection).
model ProcessedEvent {
  eventId     String   @id
  type        String
  processedAt DateTime @default(now())
}
```

- [ ] **Step 2: Create + apply the migration via CLI**

Run: `pnpm --filter @ecom/order exec prisma migrate dev --name add_processed_event`
Expected: a new folder `prisma/migrations/<ts>_add_processed_event/migration.sql` creating table `ProcessedEvent`; the Prisma client regenerates to `src/generated/prisma`. (Requires the local compose Postgres up and `services/order/.env` with `DATABASE_URL=…/order`.)

- [ ] **Step 3: Add the `transitionTx` port adapter**

In `services/order/src/tx-adapters.ts`, add the import at the top (below the existing `import type { PlaceOrderTx }` line):

```ts
import type { TransitionTx } from "./transition";
```

Then append this function to the file (after `placeOrderTx`):

```ts
// Bind a TransitionTx to one Prisma interactive-transaction client. Mirrors
// placeOrderTx; markProcessed uses createMany+skipDuplicates for an atomic
// insert-if-absent (same idiom as inventory/tx-adapters.ts).
export function transitionTx(
  tx: Prisma.TransactionClient,
  traceId: string
): TransitionTx {
  return {
    async loadOrderStatus(orderId) {
      const row = await tx.order.findUnique({
        where: { id: orderId },
        select: { status: true },
      });
      return row ? row.status : null;
    },
    async markProcessed(eventId, type) {
      const r = await tx.processedEvent.createMany({
        data: [{ eventId, type }],
        skipDuplicates: true,
      });
      return r.count > 0;
    },
    async setStatus(orderId, status) {
      await tx.order.update({ where: { id: orderId }, data: { status } });
    },
    async enqueue(type, orderId, payload) {
      await tx.outbox.create({
        data: {
          aggregateType: "order",
          aggregateId: orderId,
          type,
          traceId,
          producer: "order",
          payload: payload as Prisma.InputJsonValue,
        },
      });
    },
  };
}
```

- [ ] **Step 4: Typecheck (verifies the generated client + adapter compile)**

Run: `pnpm --filter @ecom/order typecheck`
Expected: no errors — `tx.processedEvent`, `tx.order.update({ data: { status } })`, and the `TransitionTx` shape all resolve.

- [ ] **Step 5: Commit**

```bash
git add services/order/prisma/schema.prisma services/order/prisma/migrations services/order/src/tx-adapters.ts
git commit -m "feat(order): ProcessedEvent ledger + transitionTx port adapter"
```

---

### Task 3: `handleInventoryEvent` consumer + integration test

**Files:**
- Create: `services/order/src/consumer.ts`
- Test: `services/order/src/__tests__/consumer.int.test.ts`

**Interfaces:**
- Consumes: `applyInventoryResult` (Task 1), `transitionTx` (Task 2), `prisma` (`./db`), and `INVENTORY_RESERVED`, `INVENTORY_RESERVATION_FAILED`, `InventoryReservedPayloadSchema`, `InventoryReservationFailedPayloadSchema`, `EventEnvelope`, `makeEnvelope` from `@ecom/contracts`.
- Produces: `function handleInventoryEvent(env: EventEnvelope): Promise<void>` (used by Task 4 and Task 5).

- [ ] **Step 1: Write the failing integration test**

Create `services/order/src/__tests__/consumer.int.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { handleInventoryEvent } from "../consumer";
import { prisma } from "../db";
import {
  makeEnvelope,
  INVENTORY_RESERVED,
  INVENTORY_RESERVATION_FAILED,
  ORDER_CANCELLED,
  type EventEnvelope,
} from "@ecom/contracts";

async function seedOrder(status = "PENDING"): Promise<string> {
  const order = await prisma.order.create({
    data: {
      userId: `u_${randomUUID()}`,
      status,
      totalPrice: 100,
      items: { create: [{ productId: `p_${randomUUID()}`, quantity: 1, unitPrice: 100 }] },
    },
  });
  return order.id;
}
function reserved(orderId: string): EventEnvelope {
  return makeEnvelope({
    type: INVENTORY_RESERVED,
    version: 1,
    traceId: "t",
    producer: "test",
    payload: { orderId, items: [{ productId: "p1", quantity: 1 }] },
  });
}
function failed(orderId: string): EventEnvelope {
  return makeEnvelope({
    type: INVENTORY_RESERVATION_FAILED,
    version: 1,
    traceId: "t",
    producer: "test",
    payload: { orderId, reason: "INSUFFICIENT_STOCK" },
  });
}
async function statusOf(orderId: string) {
  return (await prisma.order.findUnique({ where: { id: orderId } }))?.status;
}
const cancelledOutbox = (orderId: string) =>
  prisma.outbox.count({ where: { aggregateId: orderId, type: ORDER_CANCELLED } });
const ledgerCount = (eventId: string) =>
  prisma.processedEvent.count({ where: { eventId } });

describe("order inventory-result consumer (integration — needs docker compose up + migrated)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("InventoryReserved: PENDING -> AWAITING_PAYMENT, ledgered, no OrderCancelled", async () => {
    const orderId = await seedOrder();
    const env = reserved(orderId);
    await handleInventoryEvent(env);
    expect(await statusOf(orderId)).toBe("AWAITING_PAYMENT");
    expect(await ledgerCount(env.eventId)).toBe(1);
    expect(await cancelledOutbox(orderId)).toBe(0);
  });

  it("InventoryReservationFailed: PENDING -> CANCELLED, ledgered, one OrderCancelled outbox", async () => {
    const orderId = await seedOrder();
    const env = failed(orderId);
    await handleInventoryEvent(env);
    expect(await statusOf(orderId)).toBe("CANCELLED");
    expect(await ledgerCount(env.eventId)).toBe(1);
    expect(await cancelledOutbox(orderId)).toBe(1);
  });

  it("dedupes a redelivered event: second delivery is a no-op", async () => {
    const orderId = await seedOrder();
    const env = reserved(orderId);
    await handleInventoryEvent(env);
    await handleInventoryEvent(env); // same eventId
    expect(await statusOf(orderId)).toBe("AWAITING_PAYMENT");
    expect(await ledgerCount(env.eventId)).toBe(1);
  });

  it("unknown orderId: acked with no ProcessedEvent row (replay-recoverable)", async () => {
    const env = reserved(`o_${randomUUID()}`); // order never created
    await handleInventoryEvent(env);
    expect(await ledgerCount(env.eventId)).toBe(0);
  });

  it("out-of-order guard: Reserved after CANCELLED stays CANCELLED", async () => {
    const orderId = await seedOrder("CANCELLED");
    await handleInventoryEvent(reserved(orderId));
    expect(await statusOf(orderId)).toBe("CANCELLED");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run services/order/src/__tests__/consumer.int.test.ts`
Expected: FAIL — `Failed to resolve import "../consumer"`.

- [ ] **Step 3: Write the consumer**

Create `services/order/src/consumer.ts`:

```ts
import { createLogger, type Logger } from "@ecom/shared";
import {
  EventEnvelope,
  INVENTORY_RESERVED,
  INVENTORY_RESERVATION_FAILED,
  InventoryReservedPayloadSchema,
  InventoryReservationFailedPayloadSchema,
} from "@ecom/contracts";
import { prisma } from "./db";
import { applyInventoryResult } from "./transition";
import { transitionTx } from "./tx-adapters";

const log: Logger = createLogger("order-consumer");

export async function handleInventoryEvent(env: EventEnvelope): Promise<void> {
  let orderId: string;
  if (env.type === INVENTORY_RESERVED) {
    orderId = InventoryReservedPayloadSchema.parse(env.payload).orderId;
  } else if (env.type === INVENTORY_RESERVATION_FAILED) {
    orderId = InventoryReservationFailedPayloadSchema.parse(env.payload).orderId;
  } else {
    return; // other event types on the topic are not ours — no-op, no DLQ
  }

  const outcome = await prisma.$transaction((tx) =>
    applyInventoryResult(transitionTx(tx, env.traceId), {
      eventId: env.eventId,
      type: env.type,
      orderId,
    })
  );
  log.info("inventory_result_handled", {
    orderId,
    type: env.type,
    outcome,
    traceId: env.traceId,
  });
}
```

- [ ] **Step 4: Ensure the DB is migrated, then run the test**

Run (once, if not already applied in Task 2):
`pnpm --filter @ecom/order exec prisma migrate deploy`

Run: `pnpm vitest run services/order/src/__tests__/consumer.int.test.ts`
Expected: PASS — all 5 tests green. (Requires `docker compose up` Postgres reachable at the order `DATABASE_URL`.)

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @ecom/order typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add services/order/src/consumer.ts services/order/src/__tests__/consumer.int.test.ts
git commit -m "feat(order): inventory.events consumer — reserve leg drives PENDING->AWAITING_PAYMENT/CANCELLED"
```

---

### Task 4: Wire the consumer into `main.ts` (+ graceful shutdown)

**Files:**
- Modify: `services/order/src/main.ts`

**Interfaces:**
- Consumes: `handleInventoryEvent` (Task 3), `createConsumer` from `@ecom/shared`.
- Produces: nothing new (runtime wiring only).

- [ ] **Step 1: Replace `main.ts` with the consumer-wired version**

Overwrite `services/order/src/main.ts`:

```ts
import { createApp } from "./app";
import { config } from "./config";
import { outboxPort } from "./outbox-adapter";
import { handleInventoryEvent } from "./consumer";
import { prisma } from "./db";
import {
  createKafka,
  createProducer,
  createConsumer,
  startOutboxRelay,
  createLogger,
  gracefulShutdown,
} from "@ecom/shared";

const log = createLogger("order-main");
const INVENTORY_TOPIC = "inventory.events";

async function main() {
  const kafka = createKafka("order");
  const producer = createProducer(kafka);
  await producer.connect();

  // Relay drains the outbox; `order` aggregate rows go to `order.events`.
  const relay = startOutboxRelay(
    outboxPort,
    producer,
    (aggregateType) => `${aggregateType}.events`,
    { intervalMs: 500 }
  );

  // Consume Inventory's reservation result and drive the order state machine.
  const consumer = createConsumer(kafka, "order-consumers");
  await consumer.connect();
  await consumer.run([INVENTORY_TOPIC], handleInventoryEvent);

  const app = createApp();
  const server = app.listen(config.PORT, () =>
    log.info("order_listening", { port: config.PORT })
  );

  // runClosers() tears down in REVERSE of this array. Resulting order:
  //   server.close -> consumer.disconnect -> relay.stop -> producer.disconnect
  //   -> prisma.$disconnect
  gracefulShutdown([
    async () => {
      await prisma.$disconnect();
    },
    async () => {
      await producer.disconnect();
    },
    async () => {
      relay.stop();
    },
    async () => {
      await consumer.disconnect();
    },
    async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  ]);
}

main().catch((e) => {
  log.error("order_fatal", { message: (e as Error).message });
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck (the runtime wiring's gate; runtime is proven by Task 5's e2e)**

Run: `pnpm --filter @ecom/order typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add services/order/src/main.ts
git commit -m "feat(order): wire inventory.events consumer into main + graceful shutdown"
```

---

### Task 5: Slice e2e — real Kafka round-trip

**Files:**
- Test: `services/order/src/__tests__/inventory-leg.e2e.test.ts`

**Interfaces:**
- Consumes: `createApp` (`../app`), `handleInventoryEvent` (Task 3), `prisma` (`../db`), `createKafka`/`createProducer`/`createConsumer` from `@ecom/shared`, `makeEnvelope`/`INVENTORY_RESERVED`/`INVENTORY_RESERVATION_FAILED`/`ORDER_CANCELLED` from `@ecom/contracts`.

> **Deviation note (log to `.scratch/phase-2b/impl-notes.html`):** the spec's slice-e2e says "real Inventory service." Running Inventory in-process is not viable — each service's `db.ts` loads its own `.env` into the shared `process.env.DATABASE_URL`, so two services in one Vitest process collide on the same database. Instead the e2e publishes Inventory's **exact contract events** (`INVENTORY_RESERVED` / `INVENTORY_RESERVATION_FAILED`) onto `inventory.events` over real Kafka and runs Order's real `handleInventoryEvent` consumer — proving Order's leg end-to-end on the wire. The true two-service loop is covered by the Inventory integration suite plus a manual demo, and by Phase 7's cross-service e2e.

- [ ] **Step 1: Write the e2e test**

Create `services/order/src/__tests__/inventory-leg.e2e.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { handleInventoryEvent } from "../consumer";
import { prisma } from "../db";
import { createKafka, createProducer, createConsumer } from "@ecom/shared";
import {
  makeEnvelope,
  INVENTORY_RESERVED,
  INVENTORY_RESERVATION_FAILED,
  ORDER_CANCELLED,
} from "@ecom/contracts";

const INVENTORY_TOPIC = "inventory.events";
const app = createApp();

async function placeOrder(): Promise<string> {
  const userId = `u_${randomUUID()}`;
  const pid = `p_${randomUUID()}`;
  await request(app).post("/admin/catalog").send({ productId: pid, name: "x", price: 150 });
  await request(app)
    .post("/cart/items")
    .set("x-user-id", userId)
    .send({ productId: pid, quantity: 2 });
  const res = await request(app).post("/orders").set("x-user-id", userId);
  return res.body.orderId as string;
}
async function waitForStatus(orderId: string, want: string): Promise<string> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const got = await request(app).get(`/orders/${orderId}`);
    if (got.body.status === want) return got.body.status;
    await new Promise((r) => setTimeout(r, 400));
  }
  return (await request(app).get(`/orders/${orderId}`)).body.status;
}

describe("order inventory-leg slice e2e (needs docker compose up + migrated)", () => {
  const kafka = createKafka("order-e2e-2b");
  const producer = createProducer(kafka);
  const consumer = createConsumer(kafka, `order-e2e-2b-${Date.now()}`);

  beforeAll(async () => {
    // Pre-create the topic before subscribing (avoids KafkaJS auto-create race).
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic: INVENTORY_TOPIC, numPartitions: 1, replicationFactor: 1 }],
    });
    await admin.disconnect();

    await producer.connect();
    await consumer.connect();
    await consumer.run([INVENTORY_TOPIC], handleInventoryEvent);
  });

  afterAll(async () => {
    await consumer.disconnect();
    await producer.disconnect();
    await prisma.$disconnect();
  });

  it("InventoryReserved on the wire drives PENDING -> AWAITING_PAYMENT", async () => {
    const orderId = await placeOrder();
    await producer.publish(
      INVENTORY_TOPIC,
      makeEnvelope({
        type: INVENTORY_RESERVED,
        version: 1,
        traceId: "t",
        producer: "inventory",
        payload: { orderId, items: [{ productId: "p1", quantity: 2 }] },
      })
    );
    expect(await waitForStatus(orderId, "AWAITING_PAYMENT")).toBe("AWAITING_PAYMENT");
  }, 30000);

  it("InventoryReservationFailed drives -> CANCELLED and emits OrderCancelled", async () => {
    const orderId = await placeOrder();
    await producer.publish(
      INVENTORY_TOPIC,
      makeEnvelope({
        type: INVENTORY_RESERVATION_FAILED,
        version: 1,
        traceId: "t",
        producer: "inventory",
        payload: { orderId, reason: "INSUFFICIENT_STOCK" },
      })
    );
    expect(await waitForStatus(orderId, "CANCELLED")).toBe("CANCELLED");
    expect(
      await prisma.outbox.count({ where: { aggregateId: orderId, type: ORDER_CANCELLED } })
    ).toBe(1);
  }, 30000);
});
```

- [ ] **Step 2: Run the e2e (compose up + migrated)**

Run: `pnpm vitest run services/order/src/__tests__/inventory-leg.e2e.test.ts`
Expected: PASS — both tests green within the 30s per-test budget.

- [ ] **Step 3: Run the whole Order suite to confirm nothing regressed**

Run: `pnpm vitest run services/order`
Expected: PASS — 2a checkout tests + the new unit/int/e2e all green.

- [ ] **Step 4: Commit**

```bash
git add services/order/src/__tests__/inventory-leg.e2e.test.ts
git commit -m "test(order): inventory-leg slice e2e — real Kafka drives AWAITING_PAYMENT/CANCELLED"
```

---

## Self-Review

**Spec coverage** (each in-scope item → task):
- Kafka consumer on `inventory.events`, group `order`, dispatch + ignore-others → Task 3 (`consumer.ts`) + Task 4 (wiring).
- State machine `nextStatus` + table → Task 1.
- `ProcessedEvent` ledger, same-tx dedup → Task 2 (model + `markProcessed`) exercised in Tasks 1/3.
- `OrderCancelled` emit on `→ CANCELLED` → Task 1 (`applyInventoryResult`) + Task 2 (`enqueue`), asserted in Tasks 1/3/5.
- `GET /orders/:id` shows `AWAITING_PAYMENT`/`CANCELLED` → no code change (existing handler returns `status`); asserted via Task 5 `waitForStatus`.
- Graceful shutdown gains the consumer; teardown server-first → Task 4.
- `/readyz` unchanged (Postgres only) → no task needed (spec confirms no change).
- Testing: unit (Task 1), integration incl. duplicate/unknown/out-of-order (Task 3), slice-e2e happy+fail (Task 5).
- Load-order-before-ledger (replay-safe unknown order) → Task 1 core + asserted in Tasks 1 & 3.

**Placeholder scan:** none — every step has full code/commands/expected output.

**Type consistency:** `TransitionTx`, `nextStatus`, `applyInventoryResult`, `ApplyOutcome`, `OrderStatus` defined in Task 1 and consumed verbatim in Tasks 2–3; `handleInventoryEvent(env: EventEnvelope)` defined in Task 3 and consumed in Tasks 4–5; `transitionTx(tx, traceId)` defined in Task 2 and consumed in Task 3. `markProcessed`/`enqueue` signatures match `services/inventory` precedent.

**Known deviation (surfaced, not hidden):** Task 5 e2e emits Inventory's contract events rather than running the Inventory service in-process (shared `process.env.DATABASE_URL` collision) — logged to `.scratch/phase-2b/impl-notes.html` per the deviation note.
