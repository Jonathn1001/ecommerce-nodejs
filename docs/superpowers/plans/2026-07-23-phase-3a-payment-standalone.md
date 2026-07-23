# Phase 3a · Payment service (standalone) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `services/payment` as an independently-runnable service that consumes a `ChargePayment` command off RabbitMQ, runs a deterministic simulated gateway, persists the payment, and emits `PaymentSucceeded`/`PaymentFailed` to Kafka via the transactional outbox — with belt-and-suspenders idempotency.

**Architecture:** Mirrors `services/inventory`. A pure gateway core + a domain core (`chargeOrder`) over a tx-bound port (like `reserve.ts`/`reserveTx`); a thin `consumer.ts` runs it inside one `prisma.$transaction`. RabbitMQ is the command transport (first production use); Kafka carries the resulting events via the shared outbox relay. This slice also adds bounded retry + a health probe to the shared `consumeCommands`.

**Tech Stack:** TypeScript, Express, Prisma (custom client output `./generated/prisma`), amqplib via `@ecom/shared` `createRabbit`, KafkaJS via `@ecom/shared`, zod via `@ecom/contracts`, Vitest + supertest.

**Reference spec:** `docs/superpowers/specs/2026-07-23-phase-3a-payment-standalone-design.md`

## Global Constraints

- **New contracts only** — add `packages/contracts/src/events/payment.ts` (`CHARGE_PAYMENT`, `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED`); no change to existing event files. `CHARGE_PAYMENT`'s value `"payment.charge"` intentionally equals the queue name (different namespaces).
- **Money is integer minor units.** Gateway rule: `amount % 100 === 1` → `FAILED`, else `SUCCEEDED` (`…99` reserved for 3c TIMEOUT — currently succeeds). Demo/seed prices must avoid `…01` unless testing the decline.
- **No Redis.** Idempotency = `ProcessedEvent` (command `eventId`) + **unique `Payment.orderId`** (provider idempotency key). No lock.
- **Belt-and-suspenders dedup**, business outcomes never throw: `DUPLICATE`/`ALREADY_CHARGED`/`SUCCEEDED`/`FAILED` all *return* → normal ack, never DLQ. Only infra faults (DB down, bad payload) throw.
- **Rabbit retry lands in shared `consumeCommands`** (`maxRetries` default 3, `withRetry` + backoff, then nack→DLQ). Idempotency stays caller-side.
- **`/readyz` probes Postgres AND RabbitMQ** (deliberate divergence — Payment's job is command intake).
- **Prisma:** PascalCase models, camelCase fields, no `@map`; migrations via `prisma migrate dev` only, never hand-edit `prisma/migrations/`.
- **Logging** ids/codes only (`orderId`, `paymentId`, `outcome`, `traceId`) — never amounts-as-PII... amounts are fine (not PII); never card/secret data (there is none — simulated).
- **Port** = `3003`. **Config:** `DATABASE_URL, RABBITMQ_URL, KAFKA_BROKERS, PORT, LOG_LEVEL`.
- **Teardown order:** HTTP server drains first → `rabbit.close()` → `relay.stop()` → `producer.disconnect()` → `prisma.$disconnect()` last.
- **Infra:** int/e2e tasks need Postgres + **RabbitMQ** + Kafka up. The `payment` DB is pre-created by `infra/postgres/init/01-databases.sql`.

---

## File Structure

- **Create** `packages/contracts/src/events/payment.ts` — event constants + payload schemas. **Modify** `packages/contracts/src/index.ts` (+1 export).
- **Modify** `packages/shared/src/rabbitmq.ts` — `consumeCommands` gains `maxRetries` + `withRetry`; add `checkHealth`. **Modify** `packages/shared/src/__tests__/rabbitmq.int.test.ts` (+retry-then-success case).
- **Create** `services/payment/` — `prisma/schema.prisma`, `src/{config,db,charge,tx-adapters,consumer,app,main,outbox-adapter}.ts`, `package.json`, `tsconfig.json`, `Dockerfile`, `.dockerignore`, `.env.example`, `src/__tests__/{charge.unit,charge.int,payment.e2e}.test.ts`.
- **Modify** `docker-compose.example.yml` (+`payment` app entry), `.github/workflows/ci.yml` (+Payment integration step).

---

### Task 1: Contracts — `events/payment.ts`

**Files:**
- Create: `packages/contracts/src/events/payment.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/__tests__/payment-events.test.ts`

**Interfaces — Produces:** `CHARGE_PAYMENT`, `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED` (const strings); `ChargePaymentPayloadSchema` `{orderId, amount}`, `PaymentSucceededPayloadSchema` `{orderId, paymentId, amount}`, `PaymentFailedPayloadSchema` `{orderId, reason}` + inferred types.

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/__tests__/payment-events.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  CHARGE_PAYMENT,
  PAYMENT_SUCCEEDED,
  PAYMENT_FAILED,
  ChargePaymentPayloadSchema,
  PaymentSucceededPayloadSchema,
  PaymentFailedPayloadSchema,
} from "../events/payment";

describe("payment contracts", () => {
  it("has the expected event type strings", () => {
    expect(CHARGE_PAYMENT).toBe("payment.charge");
    expect(PAYMENT_SUCCEEDED).toBe("payment.succeeded");
    expect(PAYMENT_FAILED).toBe("payment.failed");
  });

  it("ChargePayment payload validates orderId + positive int amount", () => {
    expect(ChargePaymentPayloadSchema.parse({ orderId: "o1", amount: 100 })).toEqual({
      orderId: "o1",
      amount: 100,
    });
    expect(ChargePaymentPayloadSchema.safeParse({ orderId: "o1", amount: 0 }).success).toBe(false);
    expect(ChargePaymentPayloadSchema.safeParse({ orderId: "", amount: 100 }).success).toBe(false);
    expect(ChargePaymentPayloadSchema.safeParse({ orderId: "o1", amount: 1.5 }).success).toBe(false);
  });

  it("PaymentSucceeded / PaymentFailed payloads validate their shapes", () => {
    expect(
      PaymentSucceededPayloadSchema.parse({ orderId: "o1", paymentId: "p1", amount: 100 })
    ).toEqual({ orderId: "o1", paymentId: "p1", amount: 100 });
    expect(PaymentFailedPayloadSchema.parse({ orderId: "o1", reason: "CARD_DECLINED" })).toEqual({
      orderId: "o1",
      reason: "CARD_DECLINED",
    });
    expect(PaymentFailedPayloadSchema.safeParse({ orderId: "o1" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm vitest run packages/contracts/src/__tests__/payment-events.test.ts`
Expected: FAIL — `Failed to resolve import "../events/payment"`.

- [ ] **Step 3: Implement**

Create `packages/contracts/src/events/payment.ts`:

```ts
import { z } from "zod";

export const CHARGE_PAYMENT = "payment.charge" as const;
export const PAYMENT_SUCCEEDED = "payment.succeeded" as const;
export const PAYMENT_FAILED = "payment.failed" as const;

// RabbitMQ command. amount is integer minor units (Order is the pricing authority).
export const ChargePaymentPayloadSchema = z.object({
  orderId: z.string().min(1),
  amount: z.number().int().positive(),
});
export type ChargePaymentPayload = z.infer<typeof ChargePaymentPayloadSchema>;

export const PaymentSucceededPayloadSchema = z.object({
  orderId: z.string().min(1),
  paymentId: z.string().min(1),
  amount: z.number().int().positive(),
});
export type PaymentSucceededPayload = z.infer<typeof PaymentSucceededPayloadSchema>;

export const PaymentFailedPayloadSchema = z.object({
  orderId: z.string().min(1),
  reason: z.string().min(1),
});
export type PaymentFailedPayload = z.infer<typeof PaymentFailedPayloadSchema>;
```

Append to `packages/contracts/src/index.ts`:

```ts
export * from "./events/payment";
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm vitest run packages/contracts/src/__tests__/payment-events.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/events/payment.ts packages/contracts/src/index.ts packages/contracts/src/__tests__/payment-events.test.ts
git commit -m "feat(contracts): payment events — ChargePayment command + PaymentSucceeded/Failed"
```

---

### Task 2: Shared — bounded retry + `checkHealth` in `consumeCommands`

**Files:**
- Modify: `packages/shared/src/rabbitmq.ts`
- Test: `packages/shared/src/__tests__/rabbitmq.int.test.ts`

**Interfaces — Produces:** `consumeCommands(queue, handler, opts?: { maxRetries?: number })`; `createRabbit()` return object gains `checkHealth(): Promise<void>` (throws when the connection is down).

- [ ] **Step 1: Write the failing test (append a retry-then-success case)**

Add this `it` block inside the existing `describe` in `packages/shared/src/__tests__/rabbitmq.int.test.ts`:

```ts
  it("retries a transiently-throwing handler and acks on eventual success (no DLQ)", async () => {
    const q = `test.retry.${uuidv4()}`;
    const rabbit = await createRabbit();
    await rabbit.assertWorkQueue(q);

    let attempts = 0;
    const done: string[] = [];
    await rabbit.consumeCommands(
      q,
      async (env) => {
        attempts++;
        if (attempts < 3) throw new Error("transient"); // fail twice, succeed on the 3rd
        done.push(env.eventId);
      },
      { maxRetries: 3 }
    );
    await rabbit.sendCommand(
      q,
      makeEnvelope({ type: "cmd.retry", version: 1, traceId: "t", producer: "test", payload: {} })
    );

    const deadline = Date.now() + 10_000;
    while (done.length === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 200));

    const dlq = await rabbit.consumeDlqOnce(`${q}.dlq`, 1_000); // must be empty
    await rabbit.close();
    expect(done).toHaveLength(1); // handler eventually succeeded
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(dlq).toBeNull(); // never dead-lettered
  });
```

- [ ] **Step 2: Run it — expect FAIL**

Run (needs RabbitMQ up): `pnpm vitest run packages/shared/src/__tests__/rabbitmq.int.test.ts`
Expected: FAIL — the current `consumeCommands` has no retry, so the first throw nacks straight to `.dlq`: `done` stays empty and `dlq` is non-null. (Also a TS error on the 3rd `consumeCommands` arg until Step 3.)

- [ ] **Step 3: Implement — add the import, retry wrap, and `checkHealth`**

In `packages/shared/src/rabbitmq.ts`, add the import at the top (after the existing imports):

```ts
import { withRetry } from "./retry";
```

Inside `createRabbit`, after `const ch = await conn.createChannel();`, add connection-liveness tracking:

```ts
  let healthy = true;
  conn.on("close", () => {
    healthy = false;
  });
  conn.on("error", () => {
    healthy = false;
  });
```

Replace the whole `consumeCommands` function with:

```ts
  async function consumeCommands(
    queue: string,
    handler: (env: EventEnvelope) => Promise<void>,
    opts: { maxRetries?: number } = {}
  ): Promise<void> {
    const { maxRetries = 3 } = opts;
    await ch.consume(queue, async (msg) => {
      if (!msg) return;
      let env: EventEnvelope;
      try {
        env = EventEnvelopeSchema.parse(JSON.parse(msg.content.toString()));
      } catch {
        ch.nack(msg, false, false); // malformed envelope -> DLQ; retrying can't help
        return;
      }
      try {
        await withRetry(() => handler(env), {
          retries: maxRetries,
          baseMs: 200,
          label: `consume:${queue}`,
        });
        ch.ack(msg);
      } catch {
        ch.nack(msg, false, false); // handler exhausted retries -> DLX/DLQ
      }
    });
  }
```

Add `checkHealth` (before `close`) and include it in the returned object:

```ts
  async function checkHealth(): Promise<void> {
    if (!healthy) throw new Error("rabbit connection is down");
  }
```

Change the final return to:

```ts
  return { assertWorkQueue, sendCommand, consumeCommands, consumeDlqOnce, checkHealth, close };
```

- [ ] **Step 4: Run it — expect PASS (full shared suite, no regressions)**

Run: `pnpm vitest run packages/shared/src/__tests__/rabbitmq.int.test.ts`
Expected: PASS — both the pre-existing "throwing handler dead-letters it" case (now retries 3× first, still DLQs an always-throwing handler within its 10s deadline) and the new retry-then-success case.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @ecom/shared typecheck` (or `pnpm -r typecheck`)
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/rabbitmq.ts packages/shared/src/__tests__/rabbitmq.int.test.ts
git commit -m "feat(shared): bounded retry + checkHealth in rabbit consumeCommands"
```

---

### Task 3: Payment scaffold — schema + migration + config + db

**Files:**
- Create: `services/payment/package.json`, `services/payment/tsconfig.json`, `services/payment/prisma/schema.prisma`, `services/payment/src/config.ts`, `services/payment/src/db.ts`, `services/payment/.env.example`
- Generated: `services/payment/prisma/migrations/<ts>_init/` (CLI)

**Interfaces — Produces:** `config` (`DATABASE_URL, RABBITMQ_URL, KAFKA_BROKERS, PORT, LOG_LEVEL`); `prisma` client with models `Payment`, `PaymentAttempt`, `ProcessedEvent`, `Outbox`.

- [ ] **Step 1: package.json**

Create `services/payment/package.json`:

```json
{
  "name": "@ecom/payment",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "prisma:migrate": "prisma migrate dev",
    "start": "tsx src/main.ts"
  },
  "dependencies": {
    "@ecom/contracts": "workspace:*",
    "@ecom/shared": "workspace:*",
    "@prisma/client": "^6.1.0",
    "dotenv": "^16.4.5",
    "express": "^4.21.0",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/supertest": "^6.0.2",
    "prisma": "^6.1.0",
    "supertest": "^7.0.0"
  }
}
```

- [ ] **Step 2: tsconfig.json** (mirror `services/inventory/tsconfig.json`)

Create `services/payment/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "exclude": ["src/generated"]
}
```

- [ ] **Step 3: prisma schema**

Create `services/payment/prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// One payment per order. orderId is the provider idempotency key: a retried
// ChargePayment cannot double-charge. status in {SUCCEEDED, FAILED} (sync in 3a).
model Payment {
  id        String           @id @default(uuid())
  orderId   String           @unique
  amount    Int                              // integer minor units
  status    String
  attempts  PaymentAttempt[]
  createdAt DateTime         @default(now())
  updatedAt DateTime         @updatedAt
}

// One row per gateway call. 3a writes exactly one; 3c's retry/webhook appends.
model PaymentAttempt {
  id        String   @id @default(uuid())
  paymentId String
  outcome   String
  createdAt DateTime @default(now())
  payment   Payment  @relation(fields: [paymentId], references: [id], onDelete: Cascade)

  @@index([paymentId])
}

model ProcessedEvent {
  eventId     String   @id
  type        String
  processedAt DateTime @default(now())
}

model Outbox {
  id            String    @id @default(uuid())
  aggregateType String
  aggregateId   String
  type          String
  version       Int       @default(1)
  traceId       String
  producer      String
  payload       Json
  occurredAt    DateTime  @default(now())
  sentAt        DateTime?

  @@index([sentAt])
}
```

- [ ] **Step 4: config.ts**

Create `services/payment/src/config.ts`:

```ts
import { z } from "zod";
import { loadConfig } from "@ecom/shared";

export const config = loadConfig(
  z.object({
    DATABASE_URL: z.string().url(),
    RABBITMQ_URL: z.string().default("amqp://ecom:ecom@localhost:5672"),
    KAFKA_BROKERS: z.string().default("localhost:9092"),
    PORT: z.coerce.number().int().positive().default(3003),
    LOG_LEVEL: z.string().default("info"),
  })
);
```

- [ ] **Step 5: db.ts** (identical pattern to `services/inventory/src/db.ts`)

Create `services/payment/src/db.ts`:

```ts
import { config } from "dotenv";
import path from "path";
import { PrismaClient } from "./generated/prisma";

config({ path: path.resolve(__dirname, "../.env") });

export const prisma = new PrismaClient();
```

- [ ] **Step 6: .env.example**

Create `services/payment/.env.example`:

```
DATABASE_URL=postgresql://ecom:ecom@localhost:5432/payment
RABBITMQ_URL=amqp://ecom:ecom@localhost:5672
KAFKA_BROKERS=localhost:9092
PORT=3003
LOG_LEVEL=info
```

- [ ] **Step 7: create + apply migration** (Postgres up; needs a local `services/payment/.env` — `cp services/payment/.env.example services/payment/.env`)

Run: `pnpm --filter @ecom/payment exec prisma migrate dev --name init`
Expected: `prisma/migrations/<ts>_init/migration.sql` creating the four tables (`Payment` with unique `orderId`, `PaymentAttempt`, `ProcessedEvent`, `Outbox`); client generated to `src/generated/prisma`.

- [ ] **Step 8: install + typecheck** (new workspace package)

Run: `pnpm install` then `pnpm --filter @ecom/payment typecheck`
Expected: install links `@ecom/payment`; typecheck passes (only config/db reference the generated client so far).

- [ ] **Step 9: Commit**

```bash
git add services/payment/package.json services/payment/tsconfig.json services/payment/prisma services/payment/src/config.ts services/payment/src/db.ts services/payment/.env.example pnpm-lock.yaml
git commit -m "feat(payment): service scaffold — prisma schema + init migration + config + db"
```

---

### Task 4: Gateway core + `chargeOrder` domain core

**Files:**
- Create: `services/payment/src/charge.ts`
- Test: `services/payment/src/__tests__/charge.unit.test.ts`

**Interfaces:**
- Consumes: `CHARGE_PAYMENT`, `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED` from `@ecom/contracts`.
- Produces: `simulateCharge(amount: number): "SUCCEEDED" | "FAILED"`; `interface ChargeTx { markProcessed(eventId, type): Promise<boolean>; paymentExists(orderId): Promise<boolean>; createPayment(orderId, amount, status): Promise<string>; createAttempt(paymentId, outcome): Promise<void>; enqueue(type, orderId, payload): Promise<void> }`; `type ChargeOutcome = "DUPLICATE" | "ALREADY_CHARGED" | "SUCCEEDED" | "FAILED"`; `chargeOrder(tx, { eventId, orderId, amount }): Promise<ChargeOutcome>`.

- [ ] **Step 1: Write the failing unit test**

Create `services/payment/src/__tests__/charge.unit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { simulateCharge, chargeOrder, type ChargeTx } from "../charge";
import { PAYMENT_SUCCEEDED, PAYMENT_FAILED } from "@ecom/contracts";

function fakeTx(seed: { existingOrders?: string[] } = {}) {
  const processed = new Set<string>();
  const payments = new Set<string>(seed.existingOrders ?? []);
  const emitted: Array<{ type: string; orderId: string; payload: unknown }> = [];
  let seq = 0;
  const tx: ChargeTx = {
    async markProcessed(eventId) {
      if (processed.has(eventId)) return false;
      processed.add(eventId);
      return true;
    },
    async paymentExists(orderId) {
      return payments.has(orderId);
    },
    async createPayment(orderId) {
      payments.add(orderId);
      return `pay_${++seq}`;
    },
    async createAttempt() {},
    async enqueue(type, orderId, payload) {
      emitted.push({ type, orderId, payload });
    },
  };
  return { tx, emitted, payments, processed };
}

describe("simulateCharge (magic amounts)", () => {
  it("declines totals ending in 01, succeeds otherwise", () => {
    expect(simulateCharge(100)).toBe("SUCCEEDED");
    expect(simulateCharge(101)).toBe("FAILED");
    expect(simulateCharge(2501)).toBe("FAILED");
    expect(simulateCharge(199)).toBe("SUCCEEDED");
    expect(simulateCharge(1)).toBe("FAILED");
    expect(simulateCharge(99)).toBe("SUCCEEDED"); // 99 reserved for 3c TIMEOUT, succeeds now
  });
});

describe("chargeOrder", () => {
  it("charges a fresh order -> SUCCEEDED + PaymentSucceeded", async () => {
    const f = fakeTx();
    const outcome = await chargeOrder(f.tx, { eventId: "e1", orderId: "o1", amount: 500 });
    expect(outcome).toBe("SUCCEEDED");
    expect(f.emitted).toEqual([
      { type: PAYMENT_SUCCEEDED, orderId: "o1", payload: { orderId: "o1", paymentId: "pay_1", amount: 500 } },
    ]);
  });

  it("declines a ...01 total -> FAILED + PaymentFailed(reason CARD_DECLINED)", async () => {
    const f = fakeTx();
    const outcome = await chargeOrder(f.tx, { eventId: "e2", orderId: "o2", amount: 101 });
    expect(outcome).toBe("FAILED");
    expect(f.emitted).toEqual([
      { type: PAYMENT_FAILED, orderId: "o2", payload: { orderId: "o2", reason: "CARD_DECLINED" } },
    ]);
  });

  it("dedupes a redelivered command -> DUPLICATE, no second charge", async () => {
    const f = fakeTx();
    await chargeOrder(f.tx, { eventId: "e3", orderId: "o3", amount: 500 });
    const outcome = await chargeOrder(f.tx, { eventId: "e3", orderId: "o3", amount: 500 });
    expect(outcome).toBe("DUPLICATE");
    expect(f.emitted).toHaveLength(1);
  });

  it("re-sent command for an already-charged order -> ALREADY_CHARGED", async () => {
    const f = fakeTx({ existingOrders: ["o4"] });
    const outcome = await chargeOrder(f.tx, { eventId: "e4", orderId: "o4", amount: 500 });
    expect(outcome).toBe("ALREADY_CHARGED");
    expect(f.emitted).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm vitest run services/payment/src/__tests__/charge.unit.test.ts`
Expected: FAIL — `Failed to resolve import "../charge"`.

- [ ] **Step 3: Implement**

Create `services/payment/src/charge.ts`:

```ts
import { CHARGE_PAYMENT, PAYMENT_SUCCEEDED, PAYMENT_FAILED } from "@ecom/contracts";

// Deterministic simulated gateway (no real money). Magic amounts: a minor-units
// total ending in 01 declines; 99 is reserved for TIMEOUT (wired in 3c) so it
// currently succeeds; everything else succeeds.
export function simulateCharge(amount: number): "SUCCEEDED" | "FAILED" {
  return amount % 100 === 1 ? "FAILED" : "SUCCEEDED";
}

export interface ChargeTx {
  markProcessed(eventId: string, type: string): Promise<boolean>; // false => already processed
  paymentExists(orderId: string): Promise<boolean>;
  createPayment(orderId: string, amount: number, status: string): Promise<string>; // returns paymentId
  createAttempt(paymentId: string, outcome: string): Promise<void>;
  enqueue(type: string, orderId: string, payload: unknown): Promise<void>;
}

export type ChargeOutcome = "DUPLICATE" | "ALREADY_CHARGED" | "SUCCEEDED" | "FAILED";

// Domain core over a tx-bound port (mirrors inventory/reserve.ts). markProcessed
// first (the command CREATES the payment — no pre-existing aggregate to load);
// unique Payment.orderId is the DB-level backstop to paymentExists.
export async function chargeOrder(
  tx: ChargeTx,
  p: { eventId: string; orderId: string; amount: number }
): Promise<ChargeOutcome> {
  const fresh = await tx.markProcessed(p.eventId, CHARGE_PAYMENT);
  if (!fresh) return "DUPLICATE";

  if (await tx.paymentExists(p.orderId)) return "ALREADY_CHARGED";

  const outcome = simulateCharge(p.amount);
  const paymentId = await tx.createPayment(p.orderId, p.amount, outcome);
  await tx.createAttempt(paymentId, outcome);

  if (outcome === "SUCCEEDED") {
    await tx.enqueue(PAYMENT_SUCCEEDED, p.orderId, {
      orderId: p.orderId,
      paymentId,
      amount: p.amount,
    });
  } else {
    await tx.enqueue(PAYMENT_FAILED, p.orderId, { orderId: p.orderId, reason: "CARD_DECLINED" });
  }
  return outcome;
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm vitest run services/payment/src/__tests__/charge.unit.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add services/payment/src/charge.ts services/payment/src/__tests__/charge.unit.test.ts
git commit -m "feat(payment): simulated gateway + chargeOrder domain core (unit-tested)"
```

---

### Task 5: `chargeTx` port + `handleChargePayment` consumer + integration test

**Files:**
- Create: `services/payment/src/tx-adapters.ts`, `services/payment/src/outbox-adapter.ts`, `services/payment/src/consumer.ts`
- Test: `services/payment/src/__tests__/charge.int.test.ts`

**Interfaces:**
- Consumes: `chargeOrder`/`ChargeTx` (Task 4), `prisma` (`./db`), `ChargePaymentPayloadSchema`/`CHARGE_PAYMENT`/`EventEnvelope`/`makeEnvelope` from `@ecom/contracts`.
- Produces: `chargeTx(tx, traceId): ChargeTx`; `outboxPort: OutboxPort`; `handleChargePayment(env: EventEnvelope): Promise<void>`.

- [ ] **Step 1: Write the failing integration test**

Create `services/payment/src/__tests__/charge.int.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { handleChargePayment } from "../consumer";
import { prisma } from "../db";
import { makeEnvelope, CHARGE_PAYMENT, PAYMENT_SUCCEEDED, PAYMENT_FAILED, type EventEnvelope } from "@ecom/contracts";

function chargeCmd(orderId: string, amount: number): EventEnvelope {
  return makeEnvelope({
    type: CHARGE_PAYMENT,
    version: 1,
    traceId: "t",
    producer: "test",
    payload: { orderId, amount },
  });
}
const outboxCount = (orderId: string, type: string) =>
  prisma.outbox.count({ where: { aggregateId: orderId, type } });
const statusOf = async (orderId: string) =>
  (await prisma.payment.findUnique({ where: { orderId } }))?.status;

describe("payment charge consumer (integration — needs docker compose up + migrated)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("charges a success amount -> Payment SUCCEEDED + one PaymentSucceeded outbox + one attempt", async () => {
    const orderId = `o_${randomUUID()}`;
    await handleChargePayment(chargeCmd(orderId, 500));
    expect(await statusOf(orderId)).toBe("SUCCEEDED");
    expect(await outboxCount(orderId, PAYMENT_SUCCEEDED)).toBe(1);
    const pay = await prisma.payment.findUnique({ where: { orderId } });
    expect(await prisma.paymentAttempt.count({ where: { paymentId: pay!.id } })).toBe(1);
  });

  it("declines a ...01 amount -> Payment FAILED + one PaymentFailed outbox", async () => {
    const orderId = `o_${randomUUID()}`;
    await handleChargePayment(chargeCmd(orderId, 101));
    expect(await statusOf(orderId)).toBe("FAILED");
    expect(await outboxCount(orderId, PAYMENT_FAILED)).toBe(1);
  });

  it("dedupes a redelivered command -> one payment, one ProcessedEvent", async () => {
    const orderId = `o_${randomUUID()}`;
    const cmd = chargeCmd(orderId, 500);
    await handleChargePayment(cmd);
    await handleChargePayment(cmd); // same eventId
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1);
    expect(await prisma.processedEvent.count({ where: { eventId: cmd.eventId } })).toBe(1);
  });

  it("re-sent command (new eventId, same order) -> still one payment (ALREADY_CHARGED)", async () => {
    const orderId = `o_${randomUUID()}`;
    await handleChargePayment(chargeCmd(orderId, 500));
    await handleChargePayment(chargeCmd(orderId, 500)); // different eventId
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm vitest run services/payment/src/__tests__/charge.int.test.ts`
Expected: FAIL — `Failed to resolve import "../consumer"`.

- [ ] **Step 3: Implement the port, outbox adapter, and consumer**

Create `services/payment/src/tx-adapters.ts`:

```ts
import { Prisma } from "./generated/prisma";
import type { ChargeTx } from "./charge";

// Bind a ChargeTx to one Prisma interactive-transaction client. markProcessed uses
// createMany+skipDuplicates (atomic insert-if-absent), same idiom as inventory/order.
export function chargeTx(tx: Prisma.TransactionClient, traceId: string): ChargeTx {
  return {
    async markProcessed(eventId, type) {
      const r = await tx.processedEvent.createMany({ data: [{ eventId, type }], skipDuplicates: true });
      return r.count > 0;
    },
    async paymentExists(orderId) {
      const row = await tx.payment.findUnique({ where: { orderId }, select: { id: true } });
      return row !== null;
    },
    async createPayment(orderId, amount, status) {
      const p = await tx.payment.create({ data: { orderId, amount, status } });
      return p.id;
    },
    async createAttempt(paymentId, outcome) {
      await tx.paymentAttempt.create({ data: { paymentId, outcome } });
    },
    async enqueue(type, orderId, payload) {
      await tx.outbox.create({
        data: {
          aggregateType: "payment",
          aggregateId: orderId,
          type,
          traceId,
          producer: "payment",
          payload: payload as Prisma.InputJsonValue,
        },
      });
    },
  };
}
```

Create `services/payment/src/outbox-adapter.ts` (identical to `services/inventory/src/outbox-adapter.ts`):

```ts
import type { OutboxPort, OutboxRow } from "@ecom/shared";
import { prisma } from "./db";

export const outboxPort: OutboxPort = {
  async fetchUnsent(limit) {
    const rows = await prisma.outbox.findMany({
      where: { sentAt: null },
      orderBy: { occurredAt: "asc" },
      take: limit,
    });
    return rows as unknown as OutboxRow[];
  },
  async markSent(id) {
    await prisma.outbox.update({ where: { id }, data: { sentAt: new Date() } });
  },
};
```

Create `services/payment/src/consumer.ts`:

```ts
import { createLogger, type Logger } from "@ecom/shared";
import { EventEnvelope, CHARGE_PAYMENT, ChargePaymentPayloadSchema } from "@ecom/contracts";
import { prisma } from "./db";
import { chargeOrder } from "./charge";
import { chargeTx } from "./tx-adapters";

const log: Logger = createLogger("payment-consumer");

export async function handleChargePayment(env: EventEnvelope): Promise<void> {
  if (env.type !== CHARGE_PAYMENT) return; // not ours — no-op
  const { orderId, amount } = ChargePaymentPayloadSchema.parse(env.payload);
  const outcome = await prisma.$transaction((tx) =>
    chargeOrder(chargeTx(tx, env.traceId), { eventId: env.eventId, orderId, amount })
  );
  log.info("charge_handled", { orderId, outcome, traceId: env.traceId });
}
```

- [ ] **Step 4: Ensure DB migrated, then run**

Run: `pnpm --filter @ecom/payment exec prisma migrate deploy` (if not already applied in Task 3)
Run: `pnpm vitest run services/payment/src/__tests__/charge.int.test.ts`
Expected: PASS (4 tests) against real Postgres.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @ecom/payment typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add services/payment/src/tx-adapters.ts services/payment/src/outbox-adapter.ts services/payment/src/consumer.ts services/payment/src/__tests__/charge.int.test.ts
git commit -m "feat(payment): chargeTx port + ChargePayment consumer (one tx, idempotent)"
```

---

### Task 6: `app.ts` (health + read surface) + `main.ts` wiring

**Files:**
- Create: `services/payment/src/app.ts`, `services/payment/src/main.ts`
- Test: `services/payment/src/__tests__/app.int.test.ts`

**Interfaces:**
- Consumes: `handleChargePayment` (Task 5), `outboxPort` (Task 5), `createRabbit`/`createKafka`/`createProducer`/`startOutboxRelay`/`gracefulShutdown` from `@ecom/shared`.
- Produces: `createApp(deps: { rabbitHealth: () => Promise<void> }): express.Application`.

- [ ] **Step 1: Write the failing app integration test**

Create `services/payment/src/__tests__/app.int.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { handleChargePayment } from "../consumer";
import { prisma } from "../db";
import { makeEnvelope, CHARGE_PAYMENT } from "@ecom/contracts";

const app = createApp({ rabbitHealth: async () => {} }); // rabbit health stubbed for the app test

describe("payment app (integration — needs docker compose up + migrated)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("GET /readyz is 200 when the checks pass", async () => {
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(200);
  });

  it("GET /payments/:orderId returns the payment after a charge; 404 when unknown", async () => {
    const orderId = `o_${randomUUID()}`;
    await handleChargePayment(
      makeEnvelope({ type: CHARGE_PAYMENT, version: 1, traceId: "t", producer: "test", payload: { orderId, amount: 700 } })
    );
    const got = await request(app).get(`/payments/${orderId}`);
    expect(got.status).toBe(200);
    expect(got.body.status).toBe("SUCCEEDED");
    expect(got.body.amount).toBe(700);

    const missing = await request(app).get(`/payments/o_${randomUUID()}`);
    expect(missing.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm vitest run services/payment/src/__tests__/app.int.test.ts`
Expected: FAIL — `Failed to resolve import "../app"`.

- [ ] **Step 3: Implement `app.ts`**

Create `services/payment/src/app.ts`:

```ts
import express from "express";
import { traceMiddleware, createLogger, createHealthRouter } from "@ecom/shared";
import { prisma } from "./db";

const log = createLogger("payment");

export function createApp(deps: { rabbitHealth: () => Promise<void> }): express.Application {
  const app = express();
  app.use(express.json());
  app.use(traceMiddleware());

  app.use(
    createHealthRouter({
      db: async () => void (await prisma.$queryRaw`SELECT 1`),
      rabbit: deps.rabbitHealth,
    })
  );

  app.get("/payments/:orderId", async (req, res) => {
    try {
      const p = await prisma.payment.findUnique({ where: { orderId: req.params.orderId } });
      if (!p) return res.status(404).json({ error: "not found" });
      res.json({
        orderId: p.orderId,
        amount: p.amount,
        status: p.status,
        createdAt: p.createdAt.toISOString(),
      });
    } catch {
      log.error("payment_get_failed", { orderId: req.params.orderId, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  return app;
}
```

- [ ] **Step 4: Run the app test — expect PASS**

Run: `pnpm vitest run services/payment/src/__tests__/app.int.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement `main.ts`** (wires both transports; teardown order load-bearing)

Create `services/payment/src/main.ts`:

```ts
import { createApp } from "./app";
import { config } from "./config";
import { outboxPort } from "./outbox-adapter";
import { handleChargePayment } from "./consumer";
import { prisma } from "./db";
import {
  createKafka,
  createProducer,
  startOutboxRelay,
  createRabbit,
  createLogger,
  gracefulShutdown,
} from "@ecom/shared";

const log = createLogger("payment-main");
const CHARGE_QUEUE = "payment.charge";

async function main() {
  const kafka = createKafka("payment");
  const producer = createProducer(kafka);
  await producer.connect();

  // Relay drains the outbox; `payment` aggregate rows go to `payment.events`.
  const relay = startOutboxRelay(outboxPort, producer, (t) => `${t}.events`, { intervalMs: 500 });

  const rabbit = await createRabbit();
  await rabbit.assertWorkQueue(CHARGE_QUEUE);
  await rabbit.consumeCommands(CHARGE_QUEUE, handleChargePayment, { maxRetries: 3 });

  const app = createApp({ rabbitHealth: rabbit.checkHealth });
  const server = app.listen(config.PORT, () => log.info("payment_listening", { port: config.PORT }));

  // Reverse teardown: server.close -> rabbit.close -> relay.stop -> producer.disconnect
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
      await rabbit.close();
    },
    async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  ]);
}

main().catch((e) => {
  log.error("payment_fatal", { message: (e as Error).message });
  process.exit(1);
});
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @ecom/payment typecheck`
Expected: no errors (`rabbit.checkHealth` resolves — Task 2 added it).

- [ ] **Step 7: Commit**

```bash
git add services/payment/src/app.ts services/payment/src/main.ts services/payment/src/__tests__/app.int.test.ts
git commit -m "feat(payment): app (health + read) + main wiring (rabbit consume + kafka relay)"
```

---

### Task 7: Dockerfile + compose entry + CI step + slice e2e

**Files:**
- Create: `services/payment/Dockerfile`, `services/payment/.dockerignore`
- Modify: `docker-compose.example.yml`, `.github/workflows/ci.yml`
- Test: `services/payment/src/__tests__/payment.e2e.test.ts`

- [ ] **Step 1: Write the failing slice e2e**

Create `services/payment/src/__tests__/payment.e2e.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { outboxPort } from "../outbox-adapter";
import { handleChargePayment } from "../consumer";
import { prisma } from "../db";
import { createKafka, createProducer, createConsumer, startOutboxRelay, createRabbit } from "@ecom/shared";
import { makeEnvelope, CHARGE_PAYMENT, PAYMENT_SUCCEEDED, PAYMENT_FAILED, type EventEnvelope } from "@ecom/contracts";

const PAYMENT_TOPIC = "payment.events";
const CHARGE_QUEUE = `payment.charge.e2e.${Date.now()}`; // isolated queue per run

describe("payment slice e2e (needs docker compose up + migrated)", () => {
  const kafka = createKafka("payment-e2e");
  const producer = createProducer(kafka);
  const consumer = createConsumer(kafka, `payment-e2e-${Date.now()}`);
  let rabbit: Awaited<ReturnType<typeof createRabbit>>;
  let relay: { stop: () => void };
  const events: EventEnvelope[] = [];

  beforeAll(async () => {
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({ topics: [{ topic: PAYMENT_TOPIC, numPartitions: 1, replicationFactor: 1 }] });
    await admin.disconnect();

    await producer.connect();
    relay = startOutboxRelay(outboxPort, producer, (t) => `${t}.events`, { intervalMs: 300 });
    await consumer.connect();
    await consumer.run([PAYMENT_TOPIC], async (env) => {
      events.push(env);
    });

    rabbit = await createRabbit();
    await rabbit.assertWorkQueue(CHARGE_QUEUE);
    await rabbit.consumeCommands(CHARGE_QUEUE, handleChargePayment, { maxRetries: 3 });
  });

  afterAll(async () => {
    relay.stop();
    await consumer.disconnect();
    await producer.disconnect();
    await rabbit.close();
    await prisma.$disconnect();
  });

  async function waitFor(orderId: string, type: string): Promise<EventEnvelope | undefined> {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const hit = events.find(
        (e) => e.type === type && (e.payload as { orderId: string }).orderId === orderId
      );
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 400));
    }
    return events.find((e) => e.type === type && (e.payload as { orderId: string }).orderId === orderId);
  }

  it("ChargePayment (success amount) -> PaymentSucceeded on payment.events", async () => {
    const orderId = `o_${randomUUID()}`;
    await rabbit.sendCommand(
      CHARGE_QUEUE,
      makeEnvelope({ type: CHARGE_PAYMENT, version: 1, traceId: "t", producer: "test", payload: { orderId, amount: 500 } })
    );
    const evt = await waitFor(orderId, PAYMENT_SUCCEEDED);
    expect(evt).toBeDefined();
    expect((evt!.payload as { amount: number }).amount).toBe(500);
  }, 30000);

  it("ChargePayment (...01 amount) -> PaymentFailed on payment.events", async () => {
    const orderId = `o_${randomUUID()}`;
    await rabbit.sendCommand(
      CHARGE_QUEUE,
      makeEnvelope({ type: CHARGE_PAYMENT, version: 1, traceId: "t", producer: "test", payload: { orderId, amount: 101 } })
    );
    const evt = await waitFor(orderId, PAYMENT_FAILED);
    expect(evt).toBeDefined();
    expect((evt!.payload as { reason: string }).reason).toBe("CARD_DECLINED");
  }, 30000);

  it("a malformed-payload command (valid envelope) lands in the queue DLQ after retries", async () => {
    await rabbit.sendCommand(
      CHARGE_QUEUE,
      makeEnvelope({ type: CHARGE_PAYMENT, version: 1, traceId: "t", producer: "test", payload: { orderId: "o_bad" } }) // amount missing -> handler parse throws
    );
    const dlq = await rabbit.consumeDlqOnce(`${CHARGE_QUEUE}.dlq`, 15_000);
    expect(dlq?.type).toBe(CHARGE_PAYMENT);
  }, 30000);
});
```

- [ ] **Step 2: Run it — expect FAIL** (no infra/impl gap — this exercises everything; if run before infra is up it errors on connect)

Run (Postgres + RabbitMQ + Kafka up): `pnpm vitest run services/payment/src/__tests__/payment.e2e.test.ts`
Expected: at this point it should actually PASS if Tasks 1–6 are done (all impl exists). Run it to confirm the wiring end-to-end; if the DLQ case fails, verify the malformed payload truly throws in `handleChargePayment` (missing `amount` → `ChargePaymentPayloadSchema.parse` throws → retried → DLQ).

- [ ] **Step 3: Dockerfile + .dockerignore** (mirror `services/inventory`)

Create `services/payment/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/payment ./services/payment
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ecom/payment exec prisma generate

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/services/payment
EXPOSE 3003
CMD ["pnpm", "exec", "tsx", "src/main.ts"]
```

Create `services/payment/.dockerignore` (exact copy of `services/inventory/.dockerignore`):

```
node_modules
dist
.env
```

- [ ] **Step 4: compose app entry** — add under the `app` profile in `docker-compose.example.yml` (after the `order` entry), mirroring `inventory` but with RabbitMQ:

```yaml
  payment:
    profiles: ["app"]
    build:
      context: .
      dockerfile: services/payment/Dockerfile
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-ecom}:${POSTGRES_PASSWORD:-ecom}@postgres:5432/payment
      RABBITMQ_URL: amqp://${RABBITMQ_USER:-ecom}:${RABBITMQ_PASSWORD:-ecom}@rabbitmq:5672
      KAFKA_BROKERS: kafka:19092
      PORT: 3003
    ports: ["3003:3003"]
    depends_on:
      postgres: { condition: service_healthy }
      kafka: { condition: service_healthy }
      rabbitmq: { condition: service_healthy }
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3003/readyz || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 10
```

- [ ] **Step 5: CI integration step** — add to `.github/workflows/ci.yml` after the `Order service` step (the `integration` job already brings up RabbitMQ):

```yaml
      - name: Payment service (migrate + int/e2e)
        env:
          DATABASE_URL: postgresql://ecom:ecom@localhost:5432/payment
          RABBITMQ_URL: amqp://ecom:ecom@localhost:5672
          KAFKA_BROKERS: localhost:9092
        run: |
          pnpm --filter @ecom/payment exec prisma migrate deploy
          pnpm vitest run services/payment
```

- [ ] **Step 6: Run the whole Payment suite + shared, confirm green**

Run: `pnpm vitest run services/payment packages/shared/src/__tests__/rabbitmq.int.test.ts`
Expected: unit + int + e2e for payment all pass; shared rabbit test green. No regressions.

- [ ] **Step 7: Commit**

```bash
git add services/payment/Dockerfile services/payment/.dockerignore docker-compose.example.yml .github/workflows/ci.yml services/payment/src/__tests__/payment.e2e.test.ts
git commit -m "chore(payment): Dockerfile + compose app entry + CI step; slice e2e (rabbit->kafka)"
```

---

## Self-Review

**Spec coverage:**
- RabbitMQ consumer on `payment.charge` → Tasks 5 (handler) + 6 (main wiring).
- Simulated gateway (magic amounts, `…99` reserved) → Task 4 (`simulateCharge`), unit-tested incl. the `99`/`1`/`…01` edges.
- Persist `Payment` + `PaymentAttempt`; outbox → `payment.events` → Tasks 3 (schema) + 5 (tx port) + 6 (relay).
- Contracts `CHARGE_PAYMENT`/`PAYMENT_SUCCEEDED`/`PAYMENT_FAILED` → Task 1.
- Belt-and-suspenders idempotency (`ProcessedEvent` + unique `orderId`) → Task 3 (unique) + 4/5 (logic), asserted in Task 5 (duplicate + already-charged).
- Shared `consumeCommands` bounded retry + `checkHealth` → Task 2.
- `/readyz` probes Postgres + RabbitMQ → Task 6 (app) + 2 (`checkHealth`).
- DoD: Dockerfile + compose entry + CI step + poison→DLQ → Task 7 (e2e asserts DLQ).
- Teardown order (server→rabbit→relay→producer→prisma) → Task 6 `main.ts`.

**Placeholder scan:** none — every step has full code/commands/expected output. (`.dockerignore` contents mirror inventory's; if inventory's differs, match it.)

**Type consistency:** `ChargeTx`/`chargeOrder`/`ChargeOutcome` defined in Task 4, consumed verbatim in Task 5; `chargeTx(tx, traceId)` (Task 5) satisfies `ChargeTx`; `handleChargePayment(env)` (Task 5) consumed by Tasks 6–7; `createApp({ rabbitHealth })` (Task 6) matches its Task-6 test + `main.ts` call; `consumeCommands(..., { maxRetries })` + `checkHealth` (Task 2) consumed in Task 6.

**Infra note (surface, don't hide):** int/e2e (Tasks 2, 5, 6, 7) need **RabbitMQ** up in addition to Postgres+Kafka — the local stack currently runs only Postgres+Kafka, so bring up `rabbitmq` before those tasks (`docker compose up -d rabbitmq`). CI's `integration` job already includes it.
