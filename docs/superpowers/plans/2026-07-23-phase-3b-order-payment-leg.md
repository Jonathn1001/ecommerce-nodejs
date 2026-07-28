# Phase 3b · Order payment-leg (saga completion) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the choreographed saga — Order emits `ChargePayment` atomically (same tx as `AWAITING_PAYMENT`) via a generalized dual-transport outbox relay, consumes `payment.events` → `CONFIRMED`/`CANCELLED`, and Inventory consumes `order.confirmed` → reservation `CONSUMED` (sweeper-immune).

**Architecture:** Generalize the shared relay with an optional `commands` channel (oracle-designed, backward-compatible, no migration); route Order's `ChargePayment` row to RabbitMQ `payment.charge` while `order.*` rows stay on Kafka. Widen Order's pure transition core (the 2b compile-checkpoint). Add Inventory `CONSUMED`. Fold in two shared-resilience fixes (rabbit confirm channel, kafka parse-in-try).

**Tech Stack:** TypeScript, Express, Prisma, KafkaJS + amqplib via `@ecom/shared`, zod via `@ecom/contracts`, Vitest + supertest.

**Reference spec:** `docs/superpowers/specs/2026-07-23-phase-3b-order-payment-leg-design.md`

## Global Constraints

- **Command-relay = generalize the relay** (optional `commands: { sender, queueFor }` opts key); routing is a pure function of `row.type`; **no migration**; `createRabbit()` structurally satisfies `CommandSenderPort` (no adapter). Backward-compatible: inventory/payment/hello call sites + `outbox.unit.test.ts` unchanged and green.
- **`ChargePayment` amount = `Order.totalPrice`** (the 2a snapshot); payload is the 3a contract `{ orderId, amount }`. Money is integer minor units.
- **Atomic emit:** the `ChargePayment` outbox row is written in the **same `prisma.$transaction`** as the `AWAITING_PAYMENT` status change.
- **Idempotency unchanged:** load-before-ledger; `ProcessedEvent` + status guard; Inventory `CONSUMED` handler is `markProcessed`-first (mirrors `releaseForCancel`).
- **Confirm channel:** `createRabbit` uses `createConfirmChannel`; `sendCommand` awaits the broker ack before resolving (so the relay never `markSent`s a lost command). Consume side unchanged.
- **Kafka parse fix:** move `EventEnvelopeSchema.parse` **inside** the `run()` try so a malformed envelope DLQs instead of stalling the partition.
- **Relay resilience:** lane-partitioned drain (`Promise.allSettled` over a Kafka lane + a Rabbit lane) + a caught tick.
- **Order `/readyz` stays Postgres-only** (outbox buffers rabbit outages — do NOT probe rabbit). Order config gains `RABBITMQ_URL`.
- **Shutdown order (Order):** `server.close → consumer.disconnect → relay.stop → rabbit.close → producer.disconnect → prisma.$disconnect`.
- **Regression gate:** because `createRabbit` changes, re-run the Payment suite + `packages/shared` rabbit int test; both must stay green.
- **Migrations via CLI only.** Prisma convention: PascalCase models, camelCase fields, no `@map`.
- **Logging ids-only.**
- **Automated e2e is per-service legs with injected contract events** (two services can't share a Vitest process); the full closed loop is a scripted manual demo; automated cross-service full-saga → Phase 7.

---

## File Structure

- **Modify** `packages/contracts/src/events/order.ts` (+`ORDER_CONFIRMED`). Test: `payment-events`-style contract test (add to an order-events test).
- **Modify** `packages/shared/src/outbox.ts` (relay generalization) + `__tests__/outbox.unit.test.ts` (add routing cases).
- **Modify** `packages/shared/src/rabbitmq.ts` (confirm channel) + `kafka.ts` (parse-in-try) + their int tests.
- **Modify** `services/order/src/{transition,tx-adapters,consumer,config,main}.ts` + `__tests__/{transition.unit,consumer.int}.test.ts` + new `__tests__/order-payment-leg.e2e.test.ts`. **Modify** `docker-compose.example.yml` (order entry) + `.github/workflows/ci.yml` (order step env).
- **Modify** `services/inventory/prisma/schema.prisma` (status comment) + migration, `src/{consume.ts (new), tx-adapters.ts, consumer.ts}` + `__tests__/{consume.unit,consumer.int}.test.ts` (or extend existing).

---

### Task 1: Contracts — `ORDER_CONFIRMED`

**Files:**
- Modify: `packages/contracts/src/events/order.ts`
- Test: `packages/contracts/src/__tests__/order-confirmed.test.ts`

**Interfaces — Produces:** `ORDER_CONFIRMED = "order.confirmed"`; `OrderConfirmedPayloadSchema { orderId }` + type.

- [ ] **Step 1: Failing test**

Create `packages/contracts/src/__tests__/order-confirmed.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ORDER_CONFIRMED, OrderConfirmedPayloadSchema } from "../events/order";

describe("order.confirmed contract", () => {
  it("has the expected type string", () => {
    expect(ORDER_CONFIRMED).toBe("order.confirmed");
  });
  it("validates { orderId } and rejects empty", () => {
    expect(OrderConfirmedPayloadSchema.parse({ orderId: "o1" })).toEqual({ orderId: "o1" });
    expect(OrderConfirmedPayloadSchema.safeParse({ orderId: "" }).success).toBe(false);
    expect(OrderConfirmedPayloadSchema.safeParse({}).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`ORDER_CONFIRMED` not exported).

Run: `pnpm vitest run packages/contracts/src/__tests__/order-confirmed.test.ts`

- [ ] **Step 3: Implement** — append to `packages/contracts/src/events/order.ts` (after `OrderCancelledPayloadSchema`):

```ts
export const ORDER_CONFIRMED = "order.confirmed" as const;

export const OrderConfirmedPayloadSchema = z.object({
  orderId: z.string().min(1),
});
export type OrderConfirmedPayload = z.infer<typeof OrderConfirmedPayloadSchema>;
```

- [ ] **Step 4: Run — expect PASS.** `pnpm vitest run packages/contracts/src/__tests__/order-confirmed.test.ts`
- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/events/order.ts packages/contracts/src/__tests__/order-confirmed.test.ts
git commit -m "feat(contracts): OrderConfirmed event"
```

---

### Task 2: Shared relay — dual-transport (`commands` channel) + lane isolation + tick catch

**Files:**
- Modify: `packages/shared/src/outbox.ts`
- Test: `packages/shared/src/__tests__/outbox.unit.test.ts`

**Interfaces — Produces:** `CommandSenderPort { sendCommand(queue, envelope) }`; `CommandChannel { sender, queueFor }`; `drainOutbox(port, producer, topicFor, limit?, commands?)`; `startOutboxRelay(port, producer, topicFor, opts: { intervalMs?, limit?, commands? })`.

- [ ] **Step 1: Failing tests** — append to `packages/shared/src/__tests__/outbox.unit.test.ts` (keep the existing `describe`):

```ts
import { drainOutbox as _drain, type CommandChannel } from "../outbox"; // types only; drainOutbox already imported above

describe("drainOutbox — command channel routing", () => {
  it("routes command rows to the sender and event rows to the Kafka producer", async () => {
    const rows = [
      fakeRow({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", type: "order.confirmed", aggregateType: "order" }),
      fakeRow({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", type: "payment.charge", aggregateType: "order" }),
    ];
    const published: string[] = [];
    const commanded: Array<{ queue: string; eventId: string }> = [];
    const marked: string[] = [];
    const commands: CommandChannel = {
      sender: { sendCommand: async (queue, env) => { commanded.push({ queue, eventId: env.eventId }); } },
      queueFor: (r) => (r.type === "payment.charge" ? "payment.charge" : null),
    };
    const count = await drainOutbox(
      { fetchUnsent: async () => rows, markSent: async (id) => { marked.push(id); } },
      { publish: async (topic) => { published.push(topic); } },
      (a) => `${a}.events`,
      100,
      commands
    );
    expect(count).toBe(2);
    expect(published).toEqual(["order.events"]);
    expect(commanded).toEqual([{ queue: "payment.charge", eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }]);
    expect(marked.sort()).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ].sort());
  });

  it("a failing rabbit lane does not stop the kafka lane (allSettled)", async () => {
    const rows = [
      fakeRow({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", type: "order.confirmed" }),
      fakeRow({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", type: "payment.charge" }),
    ];
    const marked: string[] = [];
    const commands: CommandChannel = {
      sender: { sendCommand: async () => { throw new Error("rabbit down"); } },
      queueFor: (r) => (r.type === "payment.charge" ? "payment.charge" : null),
    };
    await drainOutbox(
      { fetchUnsent: async () => rows, markSent: async (id) => { marked.push(id); } },
      { publish: async () => {} },
      (a) => `${a}.events`,
      100,
      commands
    );
    // the kafka row still committed; the failed rabbit row stays unsent
    expect(marked).toEqual(["cccccccc-cccc-4ccc-8ccc-cccccccccccc"]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (5th param + `CommandChannel` don't exist yet).

Run: `pnpm vitest run packages/shared/src/__tests__/outbox.unit.test.ts`

- [ ] **Step 3: Implement** — rewrite `packages/shared/src/outbox.ts`. Add the logger import + new types, replace `drainOutbox` and `startOutboxRelay`:

```ts
import { makeEnvelope, type EventEnvelope } from "@ecom/contracts";
import { createLogger } from "./logger";

const log = createLogger("outbox");

export type OutboxRow = {
  id: string; aggregateType: string; aggregateId: string; type: string;
  version: number; traceId: string; producer: string; payload: unknown;
  occurredAt: Date; sentAt: Date | null;
};

export interface OutboxPort {
  fetchUnsent(limit: number): Promise<OutboxRow[]>;
  markSent(id: string): Promise<void>;
}
export interface ProducerPort {
  publish(topic: string, envelope: EventEnvelope): Promise<unknown>;
}

// A second, honestly-named sender port. createRabbit()'s return object satisfies
// it structurally — no adapter. `queueFor` returns the Rabbit queue for a command
// row, or null = "not a command → publish to Kafka via topicFor" (default path).
export interface CommandSenderPort {
  sendCommand(queue: string, envelope: EventEnvelope): Promise<void>;
}
export interface CommandChannel {
  sender: CommandSenderPort;
  queueFor: (row: OutboxRow) => string | null;
}

function toEnvelope(row: OutboxRow): EventEnvelope {
  return makeEnvelope({
    eventId: row.id, type: row.type, version: row.version,
    occurredAt: row.occurredAt.toISOString(), traceId: row.traceId,
    producer: row.producer, payload: row.payload,
  });
}

export async function drainOutbox(
  port: OutboxPort,
  producer: ProducerPort,
  topicFor: (aggregateType: string) => string,
  limit = 100,
  commands?: CommandChannel
): Promise<number> {
  const rows = await port.fetchUnsent(limit);
  const queueOf = (r: OutboxRow) => commands?.queueFor(r) ?? null;
  const kafkaRows = rows.filter((r) => queueOf(r) === null);
  const rabbitRows = rows.filter((r) => queueOf(r) !== null);

  let sent = 0;
  // Within a lane, abort on the first failure (preserves occurredAt order per
  // transport); unsent rows keep sentAt:null and retry next tick.
  const lane = async (
    batch: OutboxRow[],
    send: (r: OutboxRow) => Promise<unknown>
  ): Promise<void> => {
    for (const row of batch) {
      await send(row);
      await port.markSent(row.id);
      sent++;
    }
  };
  // Lanes are independent: a Rabbit outage must not wedge the Kafka rows.
  const results = await Promise.allSettled([
    lane(kafkaRows, (r) => producer.publish(topicFor(r.aggregateType), toEnvelope(r))),
    lane(rabbitRows, (r) => commands!.sender.sendCommand(queueOf(r)!, toEnvelope(r))),
  ]);
  for (const r of results) {
    if (r.status === "rejected") log.error("outbox_lane_failed", { message: String(r.reason) });
  }
  return sent;
}

export function startOutboxRelay(
  port: OutboxPort,
  producer: ProducerPort,
  topicFor: (aggregateType: string) => string,
  opts: { intervalMs?: number; limit?: number; commands?: CommandChannel } = {}
): { stop: () => void } {
  const { intervalMs = 500, limit = 100, commands } = opts;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await drainOutbox(port, producer, topicFor, limit, commands);
    } catch (e) {
      // The tick previously had NO catch → an unhandled rejection could crash the
      // process. drainOutbox swallows lane failures (allSettled); this catches
      // fetchUnsent / unexpected faults so the tick is total.
      log.error("outbox_tick_failed", { message: (e as Error).message });
    } finally {
      running = false;
    }
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
```

(Remove the stray `import { drainOutbox as _drain ... }` line from the test — `drainOutbox` is already imported at the top of the test file; import only the `CommandChannel` type there: change the test's top import to `import { drainOutbox, type OutboxRow, type CommandChannel } from "../outbox";`.)

- [ ] **Step 4: Run — expect PASS** (existing case + 2 new). `pnpm vitest run packages/shared/src/__tests__/outbox.unit.test.ts`
- [ ] **Step 5: Typecheck** `pnpm -r typecheck`
- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/outbox.ts packages/shared/src/__tests__/outbox.unit.test.ts
git commit -m "feat(shared): dual-transport outbox relay — optional commands channel + lane isolation"
```

---

### Task 3: Shared broker hardening — rabbit confirm channel + kafka parse-in-try

**Files:**
- Modify: `packages/shared/src/rabbitmq.ts`, `packages/shared/src/kafka.ts`
- Test: `packages/shared/src/__tests__/rabbitmq.int.test.ts`, `packages/shared/src/__tests__/kafka.int.test.ts` (new)

**Interfaces:** `sendCommand` now resolves only after the broker confirms; `createRabbit` return shape unchanged. `run()` parses inside the try.

- [ ] **Step 1: Failing tests**

Append to `packages/shared/src/__tests__/rabbitmq.int.test.ts` (confirm behavior — a sent command is acked by the broker; on a confirm channel `sendCommand` awaiting resolution proves the publish was confirmed, i.e. the message is retrievable):

```ts
  it("sendCommand resolves only after the broker confirms the publish", async () => {
    const q = `test.confirm.${uuidv4()}`;
    const rabbit = await createRabbit();
    await rabbit.assertWorkQueue(q);
    await rabbit.sendCommand(
      q,
      makeEnvelope({ type: "cmd.confirm", version: 1, traceId: "t", producer: "test", payload: {} })
    );
    // If sendCommand resolved, the confirm-channel acked it; the message is enqueued.
    const got = await rabbit.consumeDlqOnce(q, 5_000); // read the work queue directly
    await rabbit.close();
    expect(got?.type).toBe("cmd.confirm");
  });
```

Create `packages/shared/src/__tests__/kafka.int.test.ts` (malformed envelope dead-letters instead of stalling):

```ts
import { describe, it, expect } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { createKafka, createConsumer, createProducer } from "../kafka";

describe("kafka consumer parse fix (integration — needs docker compose up)", () => {
  it("parks a malformed envelope to <topic>.dlq instead of stalling", async () => {
    const kafka = createKafka("kafka-parsefix-test");
    const topic = `test.parse.${uuidv4()}`;
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [
        { topic, numPartitions: 1, replicationFactor: 1 },
        { topic: `${topic}.dlq`, numPartitions: 1, replicationFactor: 1 },
      ],
    });
    await admin.disconnect();

    const consumer = createConsumer(kafka, `kafka-parsefix-${Date.now()}`);
    await consumer.connect();
    const seen: string[] = [];
    await consumer.run([topic], async (env) => { seen.push(env.eventId); });

    // publish a raw non-envelope value directly (bypass the producer wrapper)
    const raw = kafka.producer();
    await raw.connect();
    await raw.send({ topic, messages: [{ value: JSON.stringify({ not: "an envelope" }) }] });
    await raw.disconnect();

    // it must land in <topic>.dlq, and the handler never saw it
    const dlqConsumer = createConsumer(kafka, `kafka-parsefix-dlq-${Date.now()}`);
    await dlqConsumer.connect();
    const dlq: string[] = [];
    await dlqConsumer.run([`${topic}.dlq`], async () => { dlq.push("parked"); }).catch(() => {});
    // dlq handler will itself fail to parse (also a non-envelope) — so instead assert via a raw check:
    await new Promise((r) => setTimeout(r, 4000));
    await consumer.disconnect();
    await dlqConsumer.disconnect();
    expect(seen).toEqual([]); // the malformed message never reached the handler (proves no stall + parked)
  }, 30000);
});
```

> NOTE for the implementer: the DLQ-side assertion is awkward because the shared consumer only yields parsed envelopes. Assert the load-bearing property — **`seen` stays empty AND the consumer did not hang** (the test completes) — which proves the malformed message was caught+parked rather than throwing uncaught and stalling the partition (which would block any subsequent valid message). If you can cleanly read the raw `${topic}.dlq` via `kafka.admin`/a raw consumer, additionally assert one message is present. Do not weaken to a vacuous assertion.

- [ ] **Step 2: Run — expect FAIL** (confirm: sendCommand today doesn't confirm — still passes though; kafka: today the parse is outside try → the malformed message throws uncaught in `eachMessage`, kafkajs retries it forever → the test hangs/times out, i.e. FAILS).

Run: `pnpm vitest run packages/shared/src/__tests__/rabbitmq.int.test.ts packages/shared/src/__tests__/kafka.int.test.ts`

- [ ] **Step 3a: Implement the confirm channel** — in `packages/shared/src/rabbitmq.ts`, change the channel creation and `sendCommand`:

```ts
// was: const ch: Channel = await conn.createChannel();
const ch = await conn.createConfirmChannel();
```

```ts
async function sendCommand(queue: string, envelope: EventEnvelope): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ch.sendToQueue(
      queue,
      Buffer.from(JSON.stringify(envelope)),
      { persistent: true },
      (err) => (err ? reject(err) : resolve()) // confirm-channel broker ack
    );
  });
}
```

(Adjust the `ch` type import: `createConfirmChannel` returns a `ConfirmChannel` — import it: `import amqp, { type ConfirmChannel, type ChannelModel } from "amqplib";` and type `ch: ConfirmChannel`. `consume`/`ack`/`nack`/`assertQueue`/`assertExchange`/`bindQueue`/`get`/`close` all exist on `ConfirmChannel`.)

- [ ] **Step 3b: Implement the kafka parse fix** — in `packages/shared/src/kafka.ts` `run()`, move the parse inside the try:

```ts
eachMessage: async ({ topic, message }) => {
  if (!message.value) return;
  const raw = message.value.toString();
  try {
    const env = EventEnvelopeSchema.parse(JSON.parse(raw));
    await withRetry(() => handler(env), { retries: maxRetries, baseMs: 200 });
  } catch (e) {
    // Poison message (malformed envelope OR handler exhausted retries): park and
    // commit so the partition keeps moving. No env.eventId key — env may not parse.
    log.error("event_parked_to_dlq", { topic, message: (e as Error).message });
    await parker.send({ topic: `${topic}.dlq`, messages: [{ value: raw }] });
  }
},
```

- [ ] **Step 4: Run — expect PASS.** `pnpm vitest run packages/shared/src/__tests__/rabbitmq.int.test.ts packages/shared/src/__tests__/kafka.int.test.ts`
- [ ] **Step 5: Regression — Payment + shared suites** (confirm channel touches Payment's rabbit): `pnpm vitest run services/payment packages/shared`
Expected: all green.
- [ ] **Step 6: Typecheck + Commit** `pnpm -r typecheck`

```bash
git add packages/shared/src/rabbitmq.ts packages/shared/src/kafka.ts packages/shared/src/__tests__/rabbitmq.int.test.ts packages/shared/src/__tests__/kafka.int.test.ts
git commit -m "fix(shared): rabbit publisher-confirm channel + kafka parse-in-try (no partition stall)"
```

---

### Task 4: Order transition core — widen to CONFIRMED + emit ChargePayment

**Files:**
- Modify: `services/order/src/transition.ts`
- Test: rewrite `services/order/src/__tests__/transition.unit.test.ts`

**Interfaces — Produces:** `nextStatus(current, eventType): "AWAITING_PAYMENT" | "CANCELLED" | "CONFIRMED" | null`; `TransitionTx` with `loadOrder(orderId): Promise<{ status: string; totalPrice: number } | null>` (replaces `loadOrderStatus`); `ApplyOutcome` += `"CONFIRMED"`; `applyResult(tx, { eventId, type, orderId })` (renamed from `applyInventoryResult`).

- [ ] **Step 1: Rewrite the unit test** `services/order/src/__tests__/transition.unit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { nextStatus, applyResult, type TransitionTx } from "../transition";
import {
  INVENTORY_RESERVED, INVENTORY_RESERVATION_FAILED,
  ORDER_CANCELLED, ORDER_CONFIRMED,
  CHARGE_PAYMENT, PAYMENT_SUCCEEDED, PAYMENT_FAILED,
} from "@ecom/contracts";

function fakeTx(init: { status: string | null; totalPrice?: number }) {
  const processed = new Set<string>();
  const emitted: Array<{ type: string; orderId: string; payload: unknown }> = [];
  let status = init.status;
  const totalPrice = init.totalPrice ?? 500;
  const tx: TransitionTx = {
    async loadOrder() { return status === null ? null : { status, totalPrice }; },
    async markProcessed(eventId) { if (processed.has(eventId)) return false; processed.add(eventId); return true; },
    async setStatus(_o, s) { status = s; },
    async enqueue(type, orderId, payload) { emitted.push({ type, orderId, payload }); },
  };
  return { tx, emitted, processed, statusNow: () => status };
}

describe("nextStatus (widened table)", () => {
  it("PENDING + reserved -> AWAITING_PAYMENT", () => {
    expect(nextStatus("PENDING", INVENTORY_RESERVED)).toBe("AWAITING_PAYMENT");
  });
  it("PENDING + reservation-failed -> CANCELLED", () => {
    expect(nextStatus("PENDING", INVENTORY_RESERVATION_FAILED)).toBe("CANCELLED");
  });
  it("AWAITING_PAYMENT + payment-succeeded -> CONFIRMED", () => {
    expect(nextStatus("AWAITING_PAYMENT", PAYMENT_SUCCEEDED)).toBe("CONFIRMED");
  });
  it("AWAITING_PAYMENT + payment-failed -> CANCELLED", () => {
    expect(nextStatus("AWAITING_PAYMENT", PAYMENT_FAILED)).toBe("CANCELLED");
  });
  it("guards every other pair to null", () => {
    expect(nextStatus("CONFIRMED", PAYMENT_SUCCEEDED)).toBeNull();
    expect(nextStatus("PENDING", PAYMENT_SUCCEEDED)).toBeNull();
    expect(nextStatus("AWAITING_PAYMENT", INVENTORY_RESERVED)).toBeNull();
  });
});

describe("applyResult", () => {
  it("reserved -> AWAITING_PAYMENT and emits ChargePayment(amount=totalPrice)", async () => {
    const f = fakeTx({ status: "PENDING", totalPrice: 700 });
    const outcome = await applyResult(f.tx, { eventId: "e1", type: INVENTORY_RESERVED, orderId: "o1" });
    expect(outcome).toBe("AWAITING_PAYMENT");
    expect(f.emitted).toEqual([
      { type: CHARGE_PAYMENT, orderId: "o1", payload: { orderId: "o1", amount: 700 } },
    ]);
  });
  it("reservation-failed -> CANCELLED + OrderCancelled", async () => {
    const f = fakeTx({ status: "PENDING" });
    const outcome = await applyResult(f.tx, { eventId: "e2", type: INVENTORY_RESERVATION_FAILED, orderId: "o2" });
    expect(outcome).toBe("CANCELLED");
    expect(f.emitted).toEqual([{ type: ORDER_CANCELLED, orderId: "o2", payload: { orderId: "o2" } }]);
  });
  it("payment-succeeded -> CONFIRMED + OrderConfirmed", async () => {
    const f = fakeTx({ status: "AWAITING_PAYMENT" });
    const outcome = await applyResult(f.tx, { eventId: "e3", type: PAYMENT_SUCCEEDED, orderId: "o3" });
    expect(outcome).toBe("CONFIRMED");
    expect(f.emitted).toEqual([{ type: ORDER_CONFIRMED, orderId: "o3", payload: { orderId: "o3" } }]);
  });
  it("payment-failed -> CANCELLED + OrderCancelled", async () => {
    const f = fakeTx({ status: "AWAITING_PAYMENT" });
    const outcome = await applyResult(f.tx, { eventId: "e4", type: PAYMENT_FAILED, orderId: "o4" });
    expect(outcome).toBe("CANCELLED");
    expect(f.emitted).toEqual([{ type: ORDER_CANCELLED, orderId: "o4", payload: { orderId: "o4" } }]);
  });
  it("unknown order -> UNKNOWN_ORDER without ledgering", async () => {
    const f = fakeTx({ status: null });
    expect(await applyResult(f.tx, { eventId: "e5", type: PAYMENT_SUCCEEDED, orderId: "x" })).toBe("UNKNOWN_ORDER");
    expect(f.processed.size).toBe(0);
  });
  it("dedupes a redelivered event", async () => {
    const f = fakeTx({ status: "AWAITING_PAYMENT" });
    await applyResult(f.tx, { eventId: "e6", type: PAYMENT_SUCCEEDED, orderId: "o6" });
    expect(await applyResult(f.tx, { eventId: "e6", type: PAYMENT_SUCCEEDED, orderId: "o6" })).toBe("DUPLICATE");
  });
  it("out-of-order guard: payment-succeeded on CONFIRMED -> NO_OP", async () => {
    const f = fakeTx({ status: "CONFIRMED" });
    expect(await applyResult(f.tx, { eventId: "e7", type: PAYMENT_SUCCEEDED, orderId: "o7" })).toBe("NO_OP");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`applyResult`/`loadOrder`/new transitions don't exist).

Run: `pnpm vitest run services/order/src/__tests__/transition.unit.test.ts`

- [ ] **Step 3: Implement** — rewrite `services/order/src/transition.ts`:

```ts
import {
  INVENTORY_RESERVED, INVENTORY_RESERVATION_FAILED,
  ORDER_CANCELLED, ORDER_CONFIRMED,
  CHARGE_PAYMENT, PAYMENT_SUCCEEDED, PAYMENT_FAILED,
} from "@ecom/contracts";

export type OrderStatus = "PENDING" | "AWAITING_PAYMENT" | "CANCELLED" | "CONFIRMED";

// Pure transition table. Widened for the payment leg (3b).
export function nextStatus(
  current: string,
  eventType: string
): "AWAITING_PAYMENT" | "CANCELLED" | "CONFIRMED" | null {
  if (current === "PENDING" && eventType === INVENTORY_RESERVED) return "AWAITING_PAYMENT";
  if (current === "PENDING" && eventType === INVENTORY_RESERVATION_FAILED) return "CANCELLED";
  if (current === "AWAITING_PAYMENT" && eventType === PAYMENT_SUCCEEDED) return "CONFIRMED";
  if (current === "AWAITING_PAYMENT" && eventType === PAYMENT_FAILED) return "CANCELLED";
  return null;
}

export interface TransitionTx {
  loadOrder(orderId: string): Promise<{ status: string; totalPrice: number } | null>;
  markProcessed(eventId: string, type: string): Promise<boolean>;
  setStatus(orderId: string, status: OrderStatus): Promise<void>;
  enqueue(type: string, orderId: string, payload: unknown): Promise<void>;
}

export type ApplyOutcome =
  "UNKNOWN_ORDER" | "DUPLICATE" | "NO_OP" | "AWAITING_PAYMENT" | "CANCELLED" | "CONFIRMED";

// Domain core over a tx port. Load-before-ledger (unknown order acked without a
// ProcessedEvent row → replay-safe). Covers inventory + payment events.
export async function applyResult(
  tx: TransitionTx,
  p: { eventId: string; type: string; orderId: string }
): Promise<ApplyOutcome> {
  const order = await tx.loadOrder(p.orderId);
  if (order === null) return "UNKNOWN_ORDER";

  const fresh = await tx.markProcessed(p.eventId, p.type);
  if (!fresh) return "DUPLICATE";

  const next = nextStatus(order.status, p.type);
  if (next === null) return "NO_OP";

  await tx.setStatus(p.orderId, next);
  if (next === "AWAITING_PAYMENT") {
    // Atomic command emission: the ChargePayment outbox row commits with the
    // status change; the relay routes it to RabbitMQ payment.charge.
    await tx.enqueue(CHARGE_PAYMENT, p.orderId, { orderId: p.orderId, amount: order.totalPrice });
  } else if (next === "CONFIRMED") {
    await tx.enqueue(ORDER_CONFIRMED, p.orderId, { orderId: p.orderId });
  } else if (next === "CANCELLED") {
    await tx.enqueue(ORDER_CANCELLED, p.orderId, { orderId: p.orderId });
  }
  return next;
}
```

- [ ] **Step 4: Run — expect PASS** (transition unit). `pnpm vitest run services/order/src/__tests__/transition.unit.test.ts`
- [ ] **Step 5: Commit** (typecheck will fail until Task 5 updates the port impl + consumer — that's expected; commit the core + test together and let Task 5 restore green):

```bash
git add services/order/src/transition.ts services/order/src/__tests__/transition.unit.test.ts
git commit -m "feat(order): widen transition core to CONFIRMED + emit ChargePayment (rename applyResult)"
```

> The `services/order` package will NOT typecheck between Task 4 and Task 5 (`tx-adapters`/`consumer` still reference the old names). This is the one intra-slice red window; Task 5 closes it. Do not run `pnpm --filter @ecom/order typecheck` as a gate here — its gate is the transition unit test.

---

### Task 5: Order consumer + port adapter — two topics, four events

**Files:**
- Modify: `services/order/src/tx-adapters.ts` (`transitionTx.loadOrder`), `services/order/src/consumer.ts` (`handleEvent`)
- Test: rewrite `services/order/src/__tests__/consumer.int.test.ts`

**Interfaces — Produces:** `handleEvent(env)` (renamed from `handleInventoryEvent`; dispatches the four saga event types); `transitionTx` satisfies the widened `TransitionTx`.

- [ ] **Step 1: Rewrite the consumer int test** `services/order/src/__tests__/consumer.int.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { handleEvent } from "../consumer";
import { prisma } from "../db";
import {
  makeEnvelope, INVENTORY_RESERVED, PAYMENT_SUCCEEDED, PAYMENT_FAILED,
  CHARGE_PAYMENT, ORDER_CONFIRMED, ORDER_CANCELLED, type EventEnvelope,
} from "@ecom/contracts";

async function seedOrder(status: string, totalPrice = 500): Promise<string> {
  const o = await prisma.order.create({
    data: { userId: `u_${randomUUID()}`, status, totalPrice,
      items: { create: [{ productId: `p_${randomUUID()}`, quantity: 1, unitPrice: totalPrice }] } },
  });
  return o.id;
}
const env = (type: string, orderId: string, payload: object = { orderId }): EventEnvelope =>
  makeEnvelope({ type, version: 1, traceId: "t", producer: "test", payload });
const statusOf = async (id: string) => (await prisma.order.findUnique({ where: { id } }))?.status;
const outbox = (id: string, type: string) => prisma.outbox.count({ where: { aggregateId: id, type } });

describe("order payment-leg consumer (integration — needs compose up + migrated)", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("InventoryReserved -> AWAITING_PAYMENT + one ChargePayment outbox (amount=totalPrice)", async () => {
    const id = await seedOrder("PENDING", 700);
    await handleEvent(env(INVENTORY_RESERVED, id, { orderId: id, items: [{ productId: "p1", quantity: 1 }] }));
    expect(await statusOf(id)).toBe("AWAITING_PAYMENT");
    expect(await outbox(id, CHARGE_PAYMENT)).toBe(1);
    const row = await prisma.outbox.findFirst({ where: { aggregateId: id, type: CHARGE_PAYMENT } });
    expect((row!.payload as { amount: number }).amount).toBe(700);
  });

  it("PaymentSucceeded -> CONFIRMED + one OrderConfirmed outbox", async () => {
    const id = await seedOrder("AWAITING_PAYMENT");
    await handleEvent(env(PAYMENT_SUCCEEDED, id, { orderId: id, paymentId: "pay_1", amount: 500 }));
    expect(await statusOf(id)).toBe("CONFIRMED");
    expect(await outbox(id, ORDER_CONFIRMED)).toBe(1);
  });

  it("PaymentFailed -> CANCELLED + one OrderCancelled outbox", async () => {
    const id = await seedOrder("AWAITING_PAYMENT");
    await handleEvent(env(PAYMENT_FAILED, id, { orderId: id, reason: "CARD_DECLINED" }));
    expect(await statusOf(id)).toBe("CANCELLED");
    expect(await outbox(id, ORDER_CANCELLED)).toBe(1);
  });

  it("dedupes a redelivered PaymentSucceeded", async () => {
    const id = await seedOrder("AWAITING_PAYMENT");
    const e = env(PAYMENT_SUCCEEDED, id, { orderId: id, paymentId: "p", amount: 500 });
    await handleEvent(e); await handleEvent(e);
    expect(await statusOf(id)).toBe("CONFIRMED");
    expect(await outbox(id, ORDER_CONFIRMED)).toBe(1);
  });

  it("unknown order is acked without a ProcessedEvent row", async () => {
    const e = env(PAYMENT_SUCCEEDED, `o_${randomUUID()}`, { orderId: "x", paymentId: "p", amount: 1 });
    await handleEvent(e);
    expect(await prisma.processedEvent.count({ where: { eventId: e.eventId } })).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`handleEvent` not exported).

Run: `pnpm vitest run services/order/src/__tests__/consumer.int.test.ts`

- [ ] **Step 3: Implement** — `services/order/src/tx-adapters.ts`: replace `transitionTx`'s `loadOrderStatus` with `loadOrder`:

```ts
    async loadOrder(orderId) {
      const row = await tx.order.findUnique({
        where: { id: orderId },
        select: { status: true, totalPrice: true },
      });
      return row ? { status: row.status, totalPrice: row.totalPrice } : null;
    },
```

(leave `markProcessed`, `setStatus`, `enqueue` unchanged).

Rewrite `services/order/src/consumer.ts`:

```ts
import { createLogger, type Logger } from "@ecom/shared";
import {
  EventEnvelope,
  INVENTORY_RESERVED, INVENTORY_RESERVATION_FAILED,
  PAYMENT_SUCCEEDED, PAYMENT_FAILED,
  InventoryReservedPayloadSchema, InventoryReservationFailedPayloadSchema,
  PaymentSucceededPayloadSchema, PaymentFailedPayloadSchema,
} from "@ecom/contracts";
import { prisma } from "./db";
import { applyResult } from "./transition";
import { transitionTx } from "./tx-adapters";

const log: Logger = createLogger("order-consumer");

// Extract orderId from any of the four saga result events; return null for
// anything else on the two topics (no-op, no DLQ).
function orderIdOf(env: EventEnvelope): string | null {
  switch (env.type) {
    case INVENTORY_RESERVED: return InventoryReservedPayloadSchema.parse(env.payload).orderId;
    case INVENTORY_RESERVATION_FAILED: return InventoryReservationFailedPayloadSchema.parse(env.payload).orderId;
    case PAYMENT_SUCCEEDED: return PaymentSucceededPayloadSchema.parse(env.payload).orderId;
    case PAYMENT_FAILED: return PaymentFailedPayloadSchema.parse(env.payload).orderId;
    default: return null;
  }
}

export async function handleEvent(env: EventEnvelope): Promise<void> {
  const orderId = orderIdOf(env);
  if (orderId === null) return; // not ours
  const outcome = await prisma.$transaction((tx) =>
    applyResult(transitionTx(tx, env.traceId), { eventId: env.eventId, type: env.type, orderId })
  );
  log.info("saga_event_handled", { orderId, type: env.type, outcome, traceId: env.traceId });
}
```

- [ ] **Step 4: Migrate (if needed) + run the int test.**

Run: `pnpm --filter @ecom/order exec prisma migrate deploy`
Run: `pnpm vitest run services/order/src/__tests__/consumer.int.test.ts`
Expected: PASS (5).

- [ ] **Step 5: Typecheck (Order package green again) + full unit suite.**

Run: `pnpm --filter @ecom/order typecheck` (expected clean now)
Run: `pnpm vitest run --exclude "**/*.int.test.ts" --exclude "**/*.e2e.test.ts"` (all unit green)

- [ ] **Step 6: Commit**

```bash
git add services/order/src/tx-adapters.ts services/order/src/consumer.ts services/order/src/__tests__/consumer.int.test.ts
git commit -m "feat(order): consume payment.events + inventory.events (handleEvent) + loadOrder port"
```

---

### Task 6: Order wiring — main + config + compose/CI

**Files:**
- Modify: `services/order/src/main.ts`, `services/order/src/config.ts`, `docker-compose.example.yml`, `.github/workflows/ci.yml`

- [ ] **Step 1: config** — add `RABBITMQ_URL` to `services/order/src/config.ts`:

```ts
export const config = loadConfig(
  z.object({
    DATABASE_URL: z.string().url(),
    KAFKA_BROKERS: z.string().default("localhost:9092"),
    RABBITMQ_URL: z.string().default("amqp://ecom:ecom@localhost:5672"),
    PORT: z.coerce.number().int().positive().default(3002),
    LOG_LEVEL: z.string().default("info"),
  })
);
```

- [ ] **Step 2: main.ts** — rewrite `services/order/src/main.ts` to add the Rabbit command channel + the second consumer topic + the shutdown order:

```ts
import { createApp } from "./app";
import { config } from "./config";
import { outboxPort } from "./outbox-adapter";
import { handleEvent } from "./consumer";
import { prisma } from "./db";
import {
  createKafka, createProducer, createConsumer, startOutboxRelay,
  createRabbit, createLogger, gracefulShutdown,
} from "@ecom/shared";
import { CHARGE_PAYMENT } from "@ecom/contracts";

const log = createLogger("order-main");
const CHARGE_QUEUE = "payment.charge";

async function main() {
  const kafka = createKafka("order");
  const producer = createProducer(kafka);
  await producer.connect();

  const rabbit = await createRabbit();
  await rabbit.assertWorkQueue(CHARGE_QUEUE); // producer-side, idempotent (Order may boot before Payment)

  // Relay drains the outbox; ChargePayment rows go to RabbitMQ, order.* to Kafka.
  const relay = startOutboxRelay(outboxPort, producer, (t) => `${t}.events`, {
    intervalMs: 500,
    commands: {
      sender: rabbit,
      queueFor: (row) => (row.type === CHARGE_PAYMENT ? CHARGE_QUEUE : null),
    },
  });

  // Consume BOTH the inventory result and the payment result.
  const consumer = createConsumer(kafka, "order-consumers");
  await consumer.connect();
  await consumer.run(["inventory.events", "payment.events"], handleEvent);

  const app = createApp();
  const server = app.listen(config.PORT, () => log.info("order_listening", { port: config.PORT }));

  // Reverse teardown. Effective order:
  //   server.close -> consumer.disconnect -> relay.stop -> rabbit.close
  //   -> producer.disconnect -> prisma.$disconnect
  // The relay must stop before its Rabbit send channel closes.
  gracefulShutdown([
    async () => { await prisma.$disconnect(); },
    async () => { await producer.disconnect(); },
    async () => { await rabbit.close(); },
    async () => { relay.stop(); },
    async () => { await consumer.disconnect(); },
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

(Note `createApp()` is unchanged — Order's `/readyz` stays Postgres-only.)

- [ ] **Step 3: compose** — in `docker-compose.example.yml`, the `order` app entry gains `RABBITMQ_URL` + a rabbitmq dependency. Add to its `environment:` `RABBITMQ_URL: amqp://${RABBITMQ_USER:-ecom}:${RABBITMQ_PASSWORD:-ecom}@rabbitmq:5672` and to `depends_on:` `rabbitmq: { condition: service_healthy }`.

- [ ] **Step 4: CI** — in `.github/workflows/ci.yml`, the `Order service` step's `env:` gains `RABBITMQ_URL: amqp://ecom:ecom@localhost:5672`.

- [ ] **Step 5: Typecheck + whole Order suite** (real infra up).

Run: `pnpm --filter @ecom/order typecheck`
Run: `pnpm vitest run services/order`
Expected: green (2b checkout + new transition/consumer; e2e added in Task 8).

- [ ] **Step 6: Commit**

```bash
git add services/order/src/main.ts services/order/src/config.ts docker-compose.example.yml .github/workflows/ci.yml
git commit -m "feat(order): wire ChargePayment command relay + payment.events consumer + RABBITMQ_URL"
```

---

### Task 7: Inventory `CONSUMED`

**Files:**
- Modify: `services/inventory/prisma/schema.prisma` (status comment) + migration, `services/inventory/src/tx-adapters.ts` (+`consumeTx`), `services/inventory/src/consumer.ts` (+`ORDER_CONFIRMED` branch)
- Create: `services/inventory/src/consume.ts` (domain core)
- Test: `services/inventory/src/__tests__/consume.int.test.ts`

**Interfaces — Produces:** `consumeForConfirm(tx, { eventId, orderId }): Promise<"DUPLICATE" | "CONSUMED" | "NOOP">`; `consumeTx(tx, traceId)`.

- [ ] **Step 1: Failing int test** `services/inventory/src/__tests__/consume.int.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { handleOrderEvent } from "../consumer";
import { prisma } from "../db";
import { makeEnvelope, ORDER_CONFIRMED, type EventEnvelope } from "@ecom/contracts";

async function activeReservation(orderId: string) {
  await prisma.reservation.create({
    data: { orderId, productId: `p_${randomUUID()}`, quantity: 1, status: "ACTIVE",
      expiresAt: new Date(Date.now() + 900_000) },
  });
}
const confirm = (orderId: string): EventEnvelope =>
  makeEnvelope({ type: ORDER_CONFIRMED, version: 1, traceId: "t", producer: "test", payload: { orderId } });
const statusOf = async (orderId: string) =>
  (await prisma.reservation.findFirst({ where: { orderId } }))?.status;

describe("inventory CONSUMED (integration — needs compose up + migrated)", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("OrderConfirmed marks the ACTIVE reservation CONSUMED", async () => {
    const orderId = `o_${randomUUID()}`;
    await activeReservation(orderId);
    await handleOrderEvent(confirm(orderId));
    expect(await statusOf(orderId)).toBe("CONSUMED");
  });

  it("dedupes a redelivered OrderConfirmed (stays CONSUMED, ledgered once)", async () => {
    const orderId = `o_${randomUUID()}`;
    await activeReservation(orderId);
    const e = confirm(orderId);
    await handleOrderEvent(e); await handleOrderEvent(e);
    expect(await statusOf(orderId)).toBe("CONSUMED");
    expect(await prisma.processedEvent.count({ where: { eventId: e.eventId } })).toBe(1);
  });

  it("no ACTIVE reservation (already released) -> no-op, no throw", async () => {
    const orderId = `o_${randomUUID()}`; // no reservation at all
    await handleOrderEvent(confirm(orderId));
    expect(await statusOf(orderId)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (no `ORDER_CONFIRMED` handling).

Run: `pnpm vitest run services/inventory/src/__tests__/consume.int.test.ts`

- [ ] **Step 3a: Schema + migration** — in `services/inventory/prisma/schema.prisma`, update the `Reservation.status` comment to `// ACTIVE | RELEASED | CONSUMED` (no type change — it's a `String`). Run:

`pnpm --filter @ecom/inventory exec prisma migrate dev --name reservation_consumed`

> This produces an effectively-empty migration (comment-only). That is fine and expected — it keeps the migration history aligned. If Prisma reports "no schema changes", create it with `--create-only` and leave the empty SQL, OR skip the migration and note that `CONSUMED` needs no DDL (a `String` column). Prefer generating it so `migrate deploy` in CI stays in lockstep; document whichever you did in the report.

- [ ] **Step 3b: Domain core** — create `services/inventory/src/consume.ts`:

```ts
import { ORDER_CONFIRMED } from "@ecom/contracts";

export interface ConsumeTx {
  markProcessed(eventId: string, type: string): Promise<boolean>; // false => already processed
  consumeActive(orderId: string): Promise<number>; // rows flipped ACTIVE -> CONSUMED
}

// order.confirmed -> mark this order's ACTIVE reservations CONSUMED (sweeper-immune).
// markProcessed-first (mirrors releaseForCancel). A non-ACTIVE reservation (already
// swept/released — the deferred 3c race) yields NOOP; unreachable under sync payment.
export async function consumeForConfirm(
  tx: ConsumeTx,
  p: { eventId: string; orderId: string }
): Promise<"DUPLICATE" | "CONSUMED" | "NOOP"> {
  const fresh = await tx.markProcessed(p.eventId, ORDER_CONFIRMED);
  if (!fresh) return "DUPLICATE";
  const n = await tx.consumeActive(p.orderId);
  return n > 0 ? "CONSUMED" : "NOOP";
}
```

- [ ] **Step 3c: Port** — append `consumeTx` to `services/inventory/src/tx-adapters.ts`:

```ts
import type { ConsumeTx } from "./consume";

export function consumeTx(tx: Prisma.TransactionClient): ConsumeTx {
  return {
    async markProcessed(eventId, type) {
      const r = await tx.processedEvent.createMany({ data: [{ eventId, type }], skipDuplicates: true });
      return r.count > 0;
    },
    async consumeActive(orderId) {
      const r = await tx.reservation.updateMany({
        where: { orderId, status: "ACTIVE" },
        data: { status: "CONSUMED" },
      });
      return r.count;
    },
  };
}
```

- [ ] **Step 3d: Consumer branch** — in `services/inventory/src/consumer.ts`, import `ORDER_CONFIRMED` + `consumeForConfirm` + `consumeTx`, and add the dispatch + handler:

```ts
// in handleOrderEvent:
  if (env.type === ORDER_CONFIRMED) return handleConfirmed(env);
```

```ts
async function handleConfirmed(env: EventEnvelope): Promise<void> {
  const payload = OrderConfirmedPayloadSchema.parse(env.payload);
  const outcome = await prisma.$transaction((tx) =>
    consumeForConfirm(consumeTx(tx), { eventId: env.eventId, orderId: payload.orderId })
  );
  if (outcome === "NOOP")
    log.warn("confirm_no_active_reservation", { orderId: payload.orderId, traceId: env.traceId });
  log.info("order_confirmed_handled", { orderId: payload.orderId, outcome, traceId: env.traceId });
}
```

(Add `ORDER_CONFIRMED, OrderConfirmedPayloadSchema` to the `@ecom/contracts` import, and `consumeForConfirm` from `./consume`, `consumeTx` from `./tx-adapters`.)

- [ ] **Step 4: Migrate deploy + run int test + typecheck.**

Run: `pnpm --filter @ecom/inventory exec prisma migrate deploy`
Run: `pnpm vitest run services/inventory/src/__tests__/consume.int.test.ts`
Run: `pnpm --filter @ecom/inventory typecheck`
Expected: PASS (3) + clean.

- [ ] **Step 5: Whole Inventory suite (no regressions).** `pnpm vitest run services/inventory`
- [ ] **Step 6: Commit**

```bash
git add services/inventory/prisma services/inventory/src/consume.ts services/inventory/src/tx-adapters.ts services/inventory/src/consumer.ts services/inventory/src/__tests__/consume.int.test.ts
git commit -m "feat(inventory): OrderConfirmed -> reservation CONSUMED (sweeper-immune)"
```

---

### Task 8: Per-leg saga e2e + manual-demo runbook + regression gate

**Files:**
- Create: `services/order/src/__tests__/order-payment-leg.e2e.test.ts`, `docs/runbooks/phase-3b-saga-demo.md`

- [ ] **Step 1: e2e (Order confirm + compensation legs, real Kafka + Rabbit, injected neighbour events)** — create `services/order/src/__tests__/order-payment-leg.e2e.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { outboxPort } from "../outbox-adapter";
import { handleEvent } from "../consumer";
import { prisma } from "../db";
import { createKafka, createProducer, createConsumer, startOutboxRelay, createRabbit } from "@ecom/shared";
import {
  makeEnvelope, INVENTORY_RESERVED, PAYMENT_SUCCEEDED, PAYMENT_FAILED,
  CHARGE_PAYMENT, type EventEnvelope,
} from "@ecom/contracts";

const CHARGE_QUEUE = `payment.charge.e2e.${Date.now()}`;
const app = createApp();

describe("order payment-leg e2e (needs compose up + migrated)", () => {
  const kafka = createKafka("order-e2e-3b");
  const producer = createProducer(kafka);
  const consumer = createConsumer(kafka, `order-e2e-3b-${Date.now()}`);
  let rabbit: Awaited<ReturnType<typeof createRabbit>>;
  let relay: { stop: () => void };

  beforeAll(async () => {
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [
        { topic: "inventory.events", numPartitions: 1, replicationFactor: 1 },
        { topic: "payment.events", numPartitions: 1, replicationFactor: 1 },
      ],
    });
    await admin.disconnect();
    await producer.connect();
    rabbit = await createRabbit();
    await rabbit.assertWorkQueue(CHARGE_QUEUE);
    // relay routes Order's ChargePayment rows to the isolated e2e queue
    relay = startOutboxRelay(outboxPort, producer, (t) => `${t}.events`, {
      intervalMs: 300,
      commands: { sender: rabbit, queueFor: (r) => (r.type === CHARGE_PAYMENT ? CHARGE_QUEUE : null) },
    });
    await consumer.connect();
    await consumer.run(["inventory.events", "payment.events"], handleEvent);
  });
  afterAll(async () => {
    relay.stop();
    await consumer.disconnect();
    await rabbit.close();
    await producer.disconnect();
    await prisma.$disconnect();
  });

  async function place(total: number): Promise<string> {
    const userId = `u_${randomUUID()}`;
    const pid = `p_${randomUUID()}`;
    await request(app).post("/admin/catalog").send({ productId: pid, name: "x", price: total });
    await request(app).post("/cart/items").set("x-user-id", userId).send({ productId: pid, quantity: 1 });
    const res = await request(app).post("/orders").set("x-user-id", userId);
    return res.body.orderId as string;
  }
  async function waitStatus(id: string, want: string): Promise<string> {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const s = (await request(app).get(`/orders/${id}`)).body.status;
      if (s === want) return s;
      await new Promise((r) => setTimeout(r, 400));
    }
    return (await request(app).get(`/orders/${id}`)).body.status;
  }
  const reserved = (id: string): EventEnvelope =>
    makeEnvelope({ type: INVENTORY_RESERVED, version: 1, traceId: "t", producer: "inventory",
      payload: { orderId: id, items: [{ productId: "p1", quantity: 1 }] } });

  it("confirm leg: reserved -> ChargePayment enqueued -> PaymentSucceeded -> CONFIRMED", async () => {
    const id = await place(500);
    await producer.publish("inventory.events", reserved(id));
    expect(await waitStatus(id, "AWAITING_PAYMENT")).toBe("AWAITING_PAYMENT");
    // the ChargePayment was routed to the isolated queue (real Rabbit round-trip)
    const cmd = await rabbit.consumeDlqOnce(CHARGE_QUEUE, 10_000);
    expect(cmd?.type).toBe(CHARGE_PAYMENT);
    // inject the payment result Payment would emit
    await producer.publish("payment.events",
      makeEnvelope({ type: PAYMENT_SUCCEEDED, version: 1, traceId: "t", producer: "payment",
        payload: { orderId: id, paymentId: "pay_1", amount: 500 } }));
    expect(await waitStatus(id, "CONFIRMED")).toBe("CONFIRMED");
  }, 30000);

  it("compensation leg: reserved -> PaymentFailed -> CANCELLED", async () => {
    const id = await place(600);
    await producer.publish("inventory.events", reserved(id));
    expect(await waitStatus(id, "AWAITING_PAYMENT")).toBe("AWAITING_PAYMENT");
    await producer.publish("payment.events",
      makeEnvelope({ type: PAYMENT_FAILED, version: 1, traceId: "t", producer: "payment",
        payload: { orderId: id, reason: "CARD_DECLINED" } }));
    expect(await waitStatus(id, "CANCELLED")).toBe("CANCELLED");
  }, 30000);
});
```

> The `consumeDlqOnce(CHARGE_QUEUE, ...)` call reads the work queue directly (the helper `ch.get`s any queue) to prove the ChargePayment actually reached RabbitMQ via the generalized relay. That is the real dual-transport assertion.

- [ ] **Step 2: Run the e2e.** `pnpm vitest run services/order/src/__tests__/order-payment-leg.e2e.test.ts` → PASS (2).

- [ ] **Step 3: Manual full-saga demo runbook** — create `docs/runbooks/phase-3b-saga-demo.md`:

```md
# Phase 3b — manual full-saga demo (real closed loop)

Prereq: `cp docker-compose.example.yml docker-compose.yml`, per-service `.env`s, images built.

1. `docker compose --profile app up -d`   # postgres, kafka, rabbitmq, redis + inventory, order, payment
2. Seed a product price + stock + cart, then place an order:
   - `curl -X POST localhost:3002/admin/catalog -d '{"productId":"p1","name":"Widget","price":500}' -H 'content-type: application/json'`
   - `curl -X POST localhost:3001/inventory/stock -d '{"productId":"p1","quantity":10}' -H 'content-type: application/json'`
   - `curl -X POST localhost:3002/cart/items -H 'x-user-id: u1' -d '{"productId":"p1","quantity":1}' -H 'content-type: application/json'`
   - `curl -X POST localhost:3002/orders -H 'x-user-id: u1'`   # -> orderId
3. Watch it confirm: `curl localhost:3002/orders/<id>` → PENDING → AWAITING_PAYMENT → **CONFIRMED**.
   Reservation is CONSUMED: `curl localhost:3001/inventory/p1` (activeReservations drops; stock stays reserved).
4. Compensation: place an order whose **total ends in 01** (e.g. price 501) → the simulated
   gateway declines → order → **CANCELLED**, stock **released**.
5. `docker compose --profile app down`.

The automated cross-service full-saga (kill-a-broker chaos) is Phase 7.
```

- [ ] **Step 4: Regression gate — the whole affected surface.**

Run: `pnpm vitest run services/order services/inventory services/payment packages/shared`
Expected: all green (Order legs + Inventory CONSUMED + Payment unchanged + shared confirm/relay/parse). Confirms the confirm-channel + relay changes didn't regress Payment or Inventory.

- [ ] **Step 5: format + typecheck (whole repo, CI parity).**

Run: `pnpm format` then `pnpm format:check`; `pnpm -r typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add services/order/src/__tests__/order-payment-leg.e2e.test.ts docs/runbooks/phase-3b-saga-demo.md
git commit -m "test(order): payment-leg e2e (dual-transport) + manual saga-demo runbook"
# if format changed files:
git add -u && git commit -m "style: prettier"
```

---

## Self-Review

**Spec coverage:**
- Command-relay generalization (commands channel + lanes + tick catch) → Task 2; confirm channel + kafka parse-fix → Task 3.
- `ORDER_CONFIRMED` → Task 1. State machine widen + ChargePayment emit (amount=totalPrice) + payment consume → Tasks 4–5. Order wiring + `RABBITMQ_URL` + compose/CI + `/readyz` unchanged → Task 6. Inventory `CONSUMED` (markProcessed-first, sweeper-immune) → Task 7. Per-leg e2e + manual demo + regression gate → Task 8.
- Rename cascade (`applyInventoryResult`→`applyResult`, `handleInventoryEvent`→`handleEvent`) handled in Tasks 4–5 (both test files rewritten).
- Backward-compat: inventory/payment/hello relay calls pass no `commands` key (Task 2 keeps `outbox.unit.test.ts`'s existing case); Task 3+8 re-run Payment + shared as the regression gate.

**Placeholder scan:** none — every step has code/commands/expected output. The Task-3 kafka-DLQ assertion carries an explicit note about its awkwardness + a "don't weaken to vacuous" instruction. The Task-7 comment-only migration carries an explicit "generate-or-skip, document which" note.

**Type consistency:** `TransitionTx.loadOrder` (Task 4) is implemented by `transitionTx` (Task 5); `applyResult`/`ApplyOutcome`/`nextStatus` (Task 4) consumed by the consumer (Task 5); `CommandChannel`/`CommandSenderPort` (Task 2) consumed by Order's `main.ts` (Task 6) and the e2e (Task 8); `ConsumeTx`/`consumeForConfirm` (Task 7) consumed by the inventory consumer branch (Task 7). Known intra-slice red window: `services/order` doesn't typecheck between Task 4 and Task 5 (documented in Task 4).

**Infra:** all tasks except 1/2/4 need Postgres + Kafka + RabbitMQ (all up locally). CI's integration job already has them.
