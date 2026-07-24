# Phase 5 · Notification (RabbitMQ showcase) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the shared rabbit adapter, then stand up `services/notification` — consume `order.events` → a `Notification` row + `SendEmail` command → a worker that renders + sends via nodemailer → mailpit, with a demoed DLQ replay.

**Architecture:** Rabbit hardening (prefetch + boot-retry + fail-fast + liveness-restart) goes FIRST since Order/Payment share `createRabbit`. `order.events` gain `userId` so the dispatcher can synthesize `<userId>@domain`. Notification mirrors the payment/catalog service shape: Kafka consumer (dispatcher) + outbox→Rabbit relay (`SendEmail`) + a Rabbit consumer (worker), Postgres dedup on both legs.

**Tech Stack:** TypeScript, Express, Prisma (Postgres), KafkaJS + amqplib via `@ecom/shared`, **nodemailer → mailpit**, zod via `@ecom/contracts`, Vitest + supertest.

**Reference spec:** `docs/superpowers/specs/2026-07-24-phase-5-notification-design.md`

## Global Constraints

- **Rabbit hardening = `ch.prefetch(N)` (default 10) + boot-retry (`withRetry` around `amqp.connect`) + fail-fast (throw on exhausted retry → the compose `restart:` policy re-boots) + liveness-restart contract.** NO in-process reconnect (Phase 7), NO degraded-adapter. `createRabbit(opts?: { prefetch?: number })` — existing callers unchanged (still throw on connect failure).
- **`userId` on all 3 `order.events`** (`OrderPlaced`/`OrderConfirmed`/`OrderCancelled`), required (`z.string().min(1)`). `transition.loadOrder` returns `{status, totalPrice, userId}`.
- **Dispatcher dedup:** `markProcessed(eventId)` + unique `(orderId,type)` in the SAME tx that `create`s the `Notification(PENDING)` and enqueues the `SendEmail` outbox row. Use `create` (not `createMany`) + catch Prisma `P2002` (need the row `id` for `{notificationId}`).
- **Worker dedup:** load the row; `status==="SENT"` → ack+skip; else send → **CAS** `updateMany({where:{id,status:"PENDING"},data:{status:"SENT",sentAt}})`.
- **`SendEmail`** = notification-local command (`SEND_EMAIL` const + `SendEmailPayloadSchema {notificationId}`); routed by the relay `commands: { sender: rabbit, queueFor: r => r.type===SEND_EMAIL ? "notifications" : null }`.
- **Mailer** = nodemailer SMTP with **bounded timeouts** (connection/greeting/socket ≈ 5s). **Recipient** = `<userId>@NOTIFY_EMAIL_DOMAIN` (default `example.test`), stored on the row.
- **`restart: unless-stopped` on ALL app compose services** (liveness-restart contract). **Logging ids-only — NEVER recipient / subject / body.** Migrations CLI-only. Per-service dotenv gitignored → inline `DATABASE_URL` in tests. `notification` DB already provisioned.

---

## File Structure

- **Modify** `packages/shared/src/rabbitmq.ts` (prefetch + boot-retry + fail-fast) + a dedup doc-note; test `packages/shared/src/__tests__/rabbitmq.int.test.ts`.
- **Modify** `packages/contracts/src/events/order.ts` (+`userId`) + test; `services/order/src/{place-order,transition,tx-adapters}.ts` + `__tests__/{transition.unit,consumer.int}.test.ts`.
- **New `services/notification/`:** scaffold (clone payment) + `prisma/schema.prisma`; `src/{config,db,outbox-adapter,main}.ts`; `src/{templates,mailer,dispatcher,worker,commands,tx-adapters}.ts`; `scripts/replay-dlq.ts`; `src/__tests__/*`.
- **Modify** `docker-compose.example.yml` (mailpit + notification + `restart:`) + `.github/workflows/ci.yml`. **Create** `docs/runbooks/phase-5-notification-demo.md`.

---

### Task 1: Rabbit adapter hardening (shared) — prefetch + boot-retry + fail-fast

**Files:**
- Modify: `packages/shared/src/rabbitmq.ts`
- Test: `packages/shared/src/__tests__/rabbitmq.int.test.ts`

**Interfaces — Produces:** `createRabbit(opts?: { prefetch?: number })` — return shape unchanged; adds `ch.prefetch`, boot-retry, fail-fast.

- [ ] **Step 1: Failing test** — append to `packages/shared/src/__tests__/rabbitmq.int.test.ts`:

```ts
  it("createRabbit throws (fail-fast) when the broker is unreachable", async () => {
    // boot-retry exhausts against a dead port, then throws — no degraded adapter
    await expect(
      createRabbit({ prefetch: 5 })
    ).rejects.toBeTruthy();
  }, 20000);
```
> This test overrides `RABBITMQ_URL` to an unreachable port for the duration. Set it in the test: `const prev = process.env.RABBITMQ_URL; process.env.RABBITMQ_URL = "amqp://ecom:ecom@localhost:5673"; try { … } finally { process.env.RABBITMQ_URL = prev; }` (5673 = no broker). Keep `baseMs` low in the impl so the retry budget stays under the 20s timeout.

Also add a prefetch assertion (the healthy path — needs the real broker):

```ts
  it("applies prefetch (bounded unacked) and still round-trips a command", async () => {
    const q = `test.prefetch.${uuidv4()}`;
    const rabbit = await createRabbit({ prefetch: 1 });
    await rabbit.assertWorkQueue(q);
    await rabbit.sendCommand(q, makeEnvelope({ type: "cmd.pf", version: 1, traceId: "t", producer: "test", payload: {} }));
    const got = await rabbit.consumeDlqOnce(q, 5000); // read the work queue directly
    await rabbit.close();
    expect(got?.type).toBe("cmd.pf");
  });
```

- [ ] **Step 2: Run — expect FAIL** (`createRabbit` takes no opts; no boot-retry → the unreachable case rejects only after amqp's own long timeout / or connects). `pnpm vitest run packages/shared/src/__tests__/rabbitmq.int.test.ts`

- [ ] **Step 3: Implement** — edit `packages/shared/src/rabbitmq.ts`. Import `withRetry`; change the top:

```ts
import { withRetry } from "./retry";

export async function createRabbit(opts: { prefetch?: number } = {}) {
  const { prefetch = 10 } = opts;
  const url = process.env.RABBITMQ_URL ?? "amqp://ecom:ecom@localhost:5672";
  // Boot-retry absorbs the broker-warming race; on exhaustion this throws (fail-fast) —
  // the caller/process exits and the compose `restart:` policy re-boots it. No degraded
  // state, no in-process reconnect (Phase 7). Mid-life drops flip `healthy=false` -> /readyz
  // unready -> restart.
  const conn: ChannelModel = await withRetry(() => amqp.connect(url), {
    retries: 5,
    baseMs: 500,
    label: "rabbit-connect",
  });
  const ch: ConfirmChannel = await conn.createConfirmChannel();
  await ch.prefetch(prefetch); // bounded unacked in-flight on every consumer
  // …rest unchanged (healthy flag, assertWorkQueue, sendCommand, consumeCommands, …)
```

Add a doc-note comment above `createRabbit` (closes the roadmap dedup-guidance debt):

```ts
// DEDUP GUIDANCE (Phase 5): default to the Postgres `ProcessedEvent` ledger (same-tx with
// a DB write — as Order/Inventory/Payment/Notification do). Use the Redis `markProcessed`
// helper (./redis.ts) ONLY for stateless / high-volume dedup with no DB write to bind to.
// It is currently unused; prefer the transactional ledger unless you have that specific need.
```

- [ ] **Step 4: Run — expect PASS.** `pnpm vitest run packages/shared/src/__tests__/rabbitmq.int.test.ts`
- [ ] **Step 5: Regression — Order + Payment rabbit paths.** `pnpm vitest run services/order services/payment packages/shared` (inline `DATABASE_URL` per service). Expected: green (the shared change is back-compatible).
- [ ] **Step 6: Typecheck + Commit** `pnpm -r typecheck`

```bash
git add packages/shared/src/rabbitmq.ts packages/shared/src/__tests__/rabbitmq.int.test.ts
git commit -m "fix(shared): rabbit prefetch + boot-retry + fail-fast (+ dedup guidance note)"
```

---

### Task 2: `order.events` widened `+userId`

**Files:**
- Modify: `packages/contracts/src/events/order.ts`, `services/order/src/{place-order,transition,tx-adapters}.ts`
- Test: `packages/contracts/src/__tests__/order-*.test.ts`, `services/order/src/__tests__/{transition.unit,consumer.int}.test.ts`

**Interfaces — Produces:** `OrderPlaced/Confirmed/CancelledPayloadSchema` gain `userId`; `TransitionTx.loadOrder → { status, totalPrice, userId }`; confirmed/cancelled emit `{orderId, userId}`.

- [ ] **Step 1: Contract test** — add to an order contract test (e.g. `packages/contracts/src/__tests__/order-confirmed.test.ts` or a new `order-userid.test.ts`):

```ts
import { OrderConfirmedPayloadSchema, OrderPlacedPayloadSchema } from "../events/order";
it("order payloads require userId", () => {
  expect(OrderConfirmedPayloadSchema.safeParse({ orderId: "o1" }).success).toBe(false);
  expect(OrderConfirmedPayloadSchema.parse({ orderId: "o1", userId: "u1" })).toEqual({ orderId: "o1", userId: "u1" });
  expect(OrderPlacedPayloadSchema.safeParse({ orderId: "o1", items: [{ productId: "p", quantity: 1 }] }).success).toBe(false); // no userId
});
```

- [ ] **Step 2: Run — expect FAIL.** `pnpm vitest run packages/contracts`

- [ ] **Step 3: Implement contracts** — in `packages/contracts/src/events/order.ts` add `userId: z.string().min(1)` to all three payload schemas:

```ts
export const OrderPlacedPayloadSchema = z.object({
  orderId: z.string().min(1),
  userId: z.string().min(1),
  items: z.array(OrderLineSchema).min(1),
});
export const OrderCancelledPayloadSchema = z.object({
  orderId: z.string().min(1),
  userId: z.string().min(1),
});
export const OrderConfirmedPayloadSchema = z.object({
  orderId: z.string().min(1),
  userId: z.string().min(1),
});
```

- [ ] **Step 4: Emit userId (Order)** —
  `services/order/src/place-order.ts` (the `ORDER_PLACED` enqueue at ~L41): add `userId: p.userId`:

```ts
  await tx.enqueue(ORDER_PLACED, orderId, {
    orderId,
    userId: p.userId,
    items: p.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
  });
```

  `services/order/src/transition.ts`: widen `TransitionTx.loadOrder` to
  `Promise<{ status: string; totalPrice: number; userId: string } | null>`; in `applyResult`
  change the confirmed/cancelled enqueues to include `order.userId`:

```ts
  } else if (next === "CONFIRMED") {
    await tx.enqueue(ORDER_CONFIRMED, p.orderId, { orderId: p.orderId, userId: order.userId });
  } else if (next === "CANCELLED") {
    await tx.enqueue(ORDER_CANCELLED, p.orderId, { orderId: p.orderId, userId: order.userId });
  }
```

  `services/order/src/tx-adapters.ts` `transitionTx.loadOrder`: add `userId` to the select:

```ts
    async loadOrder(orderId) {
      const row = await tx.order.findUnique({
        where: { id: orderId },
        select: { status: true, totalPrice: true, userId: true },
      });
      return row ? { status: row.status, totalPrice: row.totalPrice, userId: row.userId } : null;
    },
```

- [ ] **Step 5: Update Order tests** — `transition.unit.test.ts`: the `fakeTx.loadOrder` returns `{status, totalPrice, userId}` (add a `userId` to the init/return); the confirmed/cancelled emit assertions expect `{orderId, userId}`. `consumer.int.test.ts`: `seedOrder` already sets `userId`; assert the emitted `order.confirmed`/`cancelled` outbox payload includes `userId`.

- [ ] **Step 6: Run + typecheck + commit.**

Run: `pnpm vitest run packages/contracts` ; `DATABASE_URL='postgresql://ecom:ecom@localhost:5432/order' pnpm vitest run services/order` ; `pnpm --filter @ecom/order typecheck`
Expected: green.

```bash
git add packages/contracts/src/events/order.ts packages/contracts/src/__tests__ services/order/src/place-order.ts services/order/src/transition.ts services/order/src/tx-adapters.ts services/order/src/__tests__/transition.unit.test.ts services/order/src/__tests__/consumer.int.test.ts
git commit -m "feat(order): userId on order.placed/confirmed/cancelled events"
```

---

### Task 3: Notification service scaffold + schema

**Files:**
- Create: `services/notification/{package.json,tsconfig.json,Dockerfile}`, `services/notification/prisma/schema.prisma`, `services/notification/src/{config,db,outbox-adapter}.ts`
- Test: (schema/scaffold — verified by migrate + typecheck; first unit test lands in Task 4)

- [ ] **Step 1: Scaffold** (clone payment): copy `services/payment/{package.json→@ecom/notification, tsconfig.json, Dockerfile (payment→notification, EXPOSE 3005), src/db.ts, src/outbox-adapter.ts}`. Add `nodemailer` + `@types/nodemailer`:
`pnpm --filter @ecom/notification add nodemailer && pnpm --filter @ecom/notification add -D @types/nodemailer`

- [ ] **Step 2: config** — `services/notification/src/config.ts`:

```ts
import { z } from "zod";
import { loadConfig } from "@ecom/shared";
export const config = loadConfig(
  z.object({
    DATABASE_URL: z.string().url(),
    KAFKA_BROKERS: z.string().default("localhost:9092"),
    RABBITMQ_URL: z.string().default("amqp://ecom:ecom@localhost:5672"),
    SMTP_HOST: z.string().default("localhost"),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    NOTIFY_EMAIL_DOMAIN: z.string().default("example.test"),
    RABBIT_PREFETCH: z.coerce.number().int().positive().default(10),
    PORT: z.coerce.number().int().positive().default(3005),
    LOG_LEVEL: z.string().default("info"),
  })
);
```

- [ ] **Step 3: Schema + migrate** — `services/notification/prisma/schema.prisma` (generator/datasource from payment; `Outbox`+`ProcessedEvent` copied):

```prisma
model Notification {
  id        String    @id @default(uuid())
  orderId   String
  userId    String
  type      String
  to        String
  subject   String
  status    String    @default("PENDING")
  createdAt DateTime  @default(now())
  sentAt    DateTime?
  @@unique([orderId, type])
}
```
Run: `pnpm install` ; `DATABASE_URL='postgresql://ecom:ecom@localhost:5432/notification' pnpm --filter @ecom/notification exec prisma migrate dev --name notification_init` ; `pnpm --filter @ecom/notification exec prisma generate`.

- [ ] **Step 4: Typecheck + commit**

`pnpm --filter @ecom/notification typecheck` (db.ts/outbox-adapter reference `./generated/prisma` — clean after generate).

```bash
git add services/notification/package.json services/notification/tsconfig.json services/notification/Dockerfile services/notification/prisma services/notification/src/config.ts services/notification/src/db.ts services/notification/src/outbox-adapter.ts pnpm-lock.yaml
git commit -m "feat(notification): service scaffold + schema (Notification)"
```

---

### Task 4: Templates + Mailer port + SendEmail command

**Files:**
- Create: `services/notification/src/templates.ts`, `services/notification/src/mailer.ts`, `services/notification/src/commands.ts`
- Test: `services/notification/src/__tests__/templates.unit.test.ts`

**Interfaces — Produces:** `renderTemplate(type,{orderId}): {subject,html}`; `interface Mailer { send({to,subject,html}): Promise<void> }` + `createMailer(cfg): Mailer`; `SEND_EMAIL`, `SendEmailPayloadSchema`.

- [ ] **Step 1: Failing test** — `services/notification/src/__tests__/templates.unit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderTemplate } from "../templates";
import { ORDER_CONFIRMED, ORDER_PLACED, ORDER_CANCELLED } from "@ecom/contracts";

describe("renderTemplate", () => {
  it("renders a distinct subject+html per order event type, embedding orderId", () => {
    for (const type of [ORDER_PLACED, ORDER_CONFIRMED, ORDER_CANCELLED]) {
      const r = renderTemplate(type, { orderId: "o123" });
      expect(r.subject).toContain("o123");
      expect(r.html).toContain("o123");
      expect(r.subject.length).toBeGreaterThan(0);
    }
  });
  it("throws on an unknown type", () => {
    expect(() => renderTemplate("nope", { orderId: "o1" })).toThrow();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `pnpm vitest run services/notification/src/__tests__/templates.unit.test.ts`

- [ ] **Step 3: Implement** — `services/notification/src/templates.ts`:

```ts
import { ORDER_PLACED, ORDER_CONFIRMED, ORDER_CANCELLED } from "@ecom/contracts";

const MAP: Record<string, (o: { orderId: string }) => { subject: string; html: string }> = {
  [ORDER_PLACED]: ({ orderId }) => ({
    subject: `Order ${orderId} received`,
    html: `<p>We received your order <strong>${orderId}</strong>.</p>`,
  }),
  [ORDER_CONFIRMED]: ({ orderId }) => ({
    subject: `Order ${orderId} confirmed`,
    html: `<p>Your order <strong>${orderId}</strong> is confirmed.</p>`,
  }),
  [ORDER_CANCELLED]: ({ orderId }) => ({
    subject: `Order ${orderId} cancelled`,
    html: `<p>Your order <strong>${orderId}</strong> was cancelled.</p>`,
  }),
};

export function renderTemplate(type: string, o: { orderId: string }): { subject: string; html: string } {
  const fn = MAP[type];
  if (!fn) throw new Error(`no_template:${type}`);
  return fn(o);
}
```

`services/notification/src/mailer.ts`:

```ts
import nodemailer from "nodemailer";

export interface Mailer {
  send(msg: { to: string; subject: string; html: string }): Promise<void>;
}

export function createMailer(cfg: { host: string; port: number }): Mailer {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: false,
    // Bounded so a hung mailpit fails fast -> retry -> DLQ rather than blocking the worker.
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 5000,
  });
  return {
    async send(msg) {
      await transport.sendMail({ from: "no-reply@ecom.test", to: msg.to, subject: msg.subject, html: msg.html });
    },
  };
}
```

`services/notification/src/commands.ts`:

```ts
import { z } from "zod";
export const SEND_EMAIL = "notification.send_email" as const;
export const SendEmailPayloadSchema = z.object({ notificationId: z.string().min(1) });
export type SendEmailPayload = z.infer<typeof SendEmailPayloadSchema>;
```

- [ ] **Step 4: Run — expect PASS** + typecheck. `pnpm vitest run services/notification/src/__tests__/templates.unit.test.ts` ; `pnpm --filter @ecom/notification typecheck`
- [ ] **Step 5: Commit**

```bash
git add services/notification/src/templates.ts services/notification/src/mailer.ts services/notification/src/commands.ts services/notification/src/__tests__/templates.unit.test.ts
git commit -m "feat(notification): templates + Mailer port (timeouts) + SendEmail command"
```

---

### Task 5: Dispatcher — `order.events` → Notification row + SendEmail

**Files:**
- Create: `services/notification/src/dispatcher.ts`, `services/notification/src/tx-adapters.ts`
- Test: `services/notification/src/__tests__/dispatcher.unit.test.ts`, `services/notification/src/__tests__/dispatcher.int.test.ts`

**Interfaces — Produces:** `DispatchTx { markProcessed(eventId,type); createNotification({orderId,userId,type,to,subject}): Promise<string | null>; enqueue(type,aggId,payload) }`; `handleOrderEvent(env): Promise<void>`; `dispatchTx(tx, traceId, domain)`.

- [ ] **Step 1: Failing unit test** — `services/notification/src/__tests__/dispatcher.unit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applyDispatch, type DispatchTx } from "../dispatcher";
import { SEND_EMAIL } from "../commands";
import { ORDER_CONFIRMED } from "@ecom/contracts";

function fakeTx(init?: { dupEvent?: boolean; dupRow?: boolean }) {
  const emitted: Array<{ type: string; payload: any }> = [];
  const created: any[] = [];
  const tx: DispatchTx = {
    async markProcessed() { return !init?.dupEvent; },
    async createNotification(n) { if (init?.dupRow) return null; created.push(n); return "n1"; },
    async enqueue(type, _a, payload) { emitted.push({ type, payload }); },
  };
  return { tx, emitted, created };
}

describe("applyDispatch", () => {
  it("creates a notification + one SendEmail(notificationId)", async () => {
    const f = fakeTx();
    const r = await applyDispatch(f.tx, { eventId: "e1", type: ORDER_CONFIRMED, orderId: "o1", userId: "u1" }, "example.test");
    expect(r).toBe("DISPATCHED");
    expect(f.created[0]).toMatchObject({ orderId: "o1", userId: "u1", type: ORDER_CONFIRMED, to: "u1@example.test" });
    expect(f.emitted).toEqual([{ type: SEND_EMAIL, payload: { notificationId: "n1" } }]);
  });
  it("dedupes a redelivered event (markProcessed false) -> DUPLICATE, no emit", async () => {
    const f = fakeTx({ dupEvent: true });
    expect(await applyDispatch(f.tx, { eventId: "e1", type: ORDER_CONFIRMED, orderId: "o1", userId: "u1" }, "example.test")).toBe("DUPLICATE");
    expect(f.emitted).toEqual([]);
  });
  it("dedupes a duplicate (orderId,type) row -> NOOP, no emit", async () => {
    const f = fakeTx({ dupRow: true });
    expect(await applyDispatch(f.tx, { eventId: "e2", type: ORDER_CONFIRMED, orderId: "o1", userId: "u1" }, "example.test")).toBe("NOOP");
    expect(f.emitted).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — `services/notification/src/dispatcher.ts`:

```ts
import { createLogger, type Logger } from "@ecom/shared";
import {
  EventEnvelope, ORDER_PLACED, ORDER_CONFIRMED, ORDER_CANCELLED,
  OrderPlacedPayloadSchema, OrderConfirmedPayloadSchema, OrderCancelledPayloadSchema,
} from "@ecom/contracts";
import { prisma } from "./db";
import { dispatchTx } from "./tx-adapters";
import { renderTemplate } from "./templates";
import { SEND_EMAIL } from "./commands";
import { config } from "./config";

const log: Logger = createLogger("notification-dispatcher");

export interface DispatchTx {
  markProcessed(eventId: string, type: string): Promise<boolean>;
  createNotification(n: { orderId: string; userId: string; type: string; to: string; subject: string }): Promise<string | null>;
  enqueue(type: string, aggregateId: string, payload: unknown): Promise<void>;
}

export async function applyDispatch(
  tx: DispatchTx,
  p: { eventId: string; type: string; orderId: string; userId: string },
  domain: string
): Promise<"DISPATCHED" | "DUPLICATE" | "NOOP"> {
  const fresh = await tx.markProcessed(p.eventId, p.type);
  if (!fresh) return "DUPLICATE";
  const to = `${p.userId}@${domain}`;
  const { subject } = renderTemplate(p.type, { orderId: p.orderId });
  const notificationId = await tx.createNotification({ orderId: p.orderId, userId: p.userId, type: p.type, to, subject });
  if (notificationId === null) return "NOOP"; // (orderId,type) already exists
  await tx.enqueue(SEND_EMAIL, p.orderId, { notificationId });
  return "DISPATCHED";
}

function parse(env: EventEnvelope): { orderId: string; userId: string } | null {
  switch (env.type) {
    case ORDER_PLACED: { const x = OrderPlacedPayloadSchema.parse(env.payload); return { orderId: x.orderId, userId: x.userId }; }
    case ORDER_CONFIRMED: { const x = OrderConfirmedPayloadSchema.parse(env.payload); return { orderId: x.orderId, userId: x.userId }; }
    case ORDER_CANCELLED: { const x = OrderCancelledPayloadSchema.parse(env.payload); return { orderId: x.orderId, userId: x.userId }; }
    default: return null;
  }
}

export async function handleOrderEvent(env: EventEnvelope): Promise<void> {
  const p = parse(env);
  if (p === null) return; // not ours
  const outcome = await prisma.$transaction((tx) =>
    applyDispatch(dispatchTx(tx, env.traceId), { eventId: env.eventId, type: env.type, orderId: p.orderId, userId: p.userId }, config.NOTIFY_EMAIL_DOMAIN)
  );
  log.info("order_event_dispatched", { orderId: p.orderId, type: env.type, outcome, traceId: env.traceId });
}
```

`services/notification/src/tx-adapters.ts`:

```ts
import { Prisma } from "./generated/prisma";
import type { DispatchTx } from "./dispatcher";

export function dispatchTx(tx: Prisma.TransactionClient, traceId: string): DispatchTx {
  return {
    async markProcessed(eventId, type) {
      const r = await tx.processedEvent.createMany({ data: [{ eventId, type }], skipDuplicates: true });
      return r.count > 0;
    },
    async createNotification(n) {
      try {
        const row = await tx.notification.create({ data: n });
        return row.id;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return null; // (orderId,type) unique
        throw e;
      }
    },
    async enqueue(type, aggregateId, payload) {
      await tx.outbox.create({
        data: { aggregateType: "notification", aggregateId, type, traceId, producer: "notification", payload: payload as Prisma.InputJsonValue },
      });
    },
  };
}
```

- [ ] **Step 4: Failing int test** — `services/notification/src/__tests__/dispatcher.int.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { handleOrderEvent } from "../dispatcher";
import { prisma } from "../db";
import { makeEnvelope, ORDER_CONFIRMED, type EventEnvelope } from "@ecom/contracts";
import { SEND_EMAIL } from "../commands";

const ev = (orderId: string, userId: string): EventEnvelope =>
  makeEnvelope({ type: ORDER_CONFIRMED, version: 1, traceId: "t", producer: "order", payload: { orderId, userId } });

describe("notification dispatcher (integration)", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("creates one Notification(PENDING) + one SendEmail outbox; dedupes redelivery", async () => {
    const orderId = `o_${randomUUID()}`;
    const e = ev(orderId, "u1");
    await handleOrderEvent(e);
    await handleOrderEvent(e); // redelivery
    const n = await prisma.notification.findFirst({ where: { orderId, type: ORDER_CONFIRMED } });
    expect(n?.status).toBe("PENDING");
    expect(n?.to).toBe("u1@example.test");
    expect(await prisma.outbox.count({ where: { aggregateId: orderId, type: SEND_EMAIL } })).toBe(1);
    expect(await prisma.processedEvent.count({ where: { eventId: e.eventId } })).toBe(1);
  });
});
```

- [ ] **Step 5: migrate deploy + run unit & int + typecheck.**

`DATABASE_URL='postgresql://ecom:ecom@localhost:5432/notification' pnpm --filter @ecom/notification exec prisma migrate deploy`
`DATABASE_URL='postgresql://ecom:ecom@localhost:5432/notification' pnpm vitest run services/notification/src/__tests__/dispatcher.unit.test.ts services/notification/src/__tests__/dispatcher.int.test.ts`
`pnpm --filter @ecom/notification typecheck`

- [ ] **Step 6: Commit**

```bash
git add services/notification/src/dispatcher.ts services/notification/src/tx-adapters.ts services/notification/src/__tests__/dispatcher.unit.test.ts services/notification/src/__tests__/dispatcher.int.test.ts
git commit -m "feat(notification): dispatcher (order.events -> Notification + SendEmail, dedup)"
```

---

### Task 6: Worker — SendEmail → render → mail → CAS SENT

**Files:**
- Create: `services/notification/src/worker.ts`
- Test: `services/notification/src/__tests__/worker.unit.test.ts`

**Interfaces — Produces:** `WorkerDeps { mailer: Mailer }`; `handleSendEmail(env, deps): Promise<void>`; `applySend(loadRow, casSent, mailer, notificationId): Promise<"SENT" | "SKIP">`.

- [ ] **Step 1: Failing unit test** — `services/notification/src/__tests__/worker.unit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applySend, type SendRow, type WorkerPort } from "../worker";
import { ORDER_CONFIRMED } from "@ecom/contracts";

function fakePort(row: SendRow | null) {
  const sent: any[] = [];
  let status = row?.status;
  const port: WorkerPort = {
    async loadRow() { return row ? { ...row, status: status! } : null; },
    async casSent() { if (status === "PENDING") { status = "SENT"; return 1; } return 0; },
  };
  const mailer = { async send(m: any) { sent.push(m); } };
  return { port, mailer, sent, statusNow: () => status };
}

const row: SendRow = { id: "n1", to: "u1@example.test", type: ORDER_CONFIRMED, orderId: "o1", status: "PENDING" };

describe("applySend", () => {
  it("PENDING -> render+send+CAS SENT", async () => {
    const f = fakePort(row);
    expect(await applySend(f.port, f.mailer, "n1")).toBe("SENT");
    expect(f.sent[0].to).toBe("u1@example.test");
    expect(f.statusNow()).toBe("SENT");
  });
  it("already SENT -> SKIP, no send", async () => {
    const f = fakePort({ ...row, status: "SENT" });
    expect(await applySend(f.port, f.mailer, "n1")).toBe("SKIP");
    expect(f.sent).toEqual([]);
  });
  it("missing row -> SKIP", async () => {
    const f = fakePort(null);
    expect(await applySend(f.port, f.mailer, "x")).toBe("SKIP");
  });
  it("mailer throwing propagates (so consumeCommands retries -> DLQ); row stays PENDING", async () => {
    const f = fakePort(row);
    const throwing = { async send() { throw new Error("smtp down"); } };
    await expect(applySend(f.port, throwing, "n1")).rejects.toThrow();
    expect(f.statusNow()).toBe("PENDING");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — `services/notification/src/worker.ts`:

```ts
import { createLogger, type Logger } from "@ecom/shared";
import { type EventEnvelope } from "@ecom/contracts";
import { prisma } from "./db";
import { renderTemplate } from "./templates";
import { SendEmailPayloadSchema } from "./commands";
import type { Mailer } from "./mailer";

const log: Logger = createLogger("notification-worker");

export type SendRow = { id: string; to: string; type: string; orderId: string; status: string };
export interface WorkerPort {
  loadRow(id: string): Promise<SendRow | null>;
  casSent(id: string): Promise<number>; // updateMany where status=PENDING -> SENT; returns count
}

export async function applySend(port: WorkerPort, mailer: Mailer, notificationId: string): Promise<"SENT" | "SKIP"> {
  const row = await port.loadRow(notificationId);
  if (row === null || row.status === "SENT") return "SKIP"; // redelivery / dedup
  const { subject, html } = renderTemplate(row.type, { orderId: row.orderId });
  await mailer.send({ to: row.to, subject, html }); // throws -> caller retries -> DLQ; row stays PENDING
  const n = await port.casSent(notificationId);
  return n > 0 ? "SENT" : "SKIP"; // a concurrent worker won the CAS
}

const workerPort: WorkerPort = {
  async loadRow(id) {
    const r = await prisma.notification.findUnique({ where: { id }, select: { id: true, to: true, type: true, orderId: true, status: true } });
    return r ?? null;
  },
  async casSent(id) {
    const r = await prisma.notification.updateMany({ where: { id, status: "PENDING" }, data: { status: "SENT", sentAt: new Date() } });
    return r.count;
  },
};

export function makeHandleSendEmail(mailer: Mailer) {
  return async function handleSendEmail(env: EventEnvelope): Promise<void> {
    const { notificationId } = SendEmailPayloadSchema.parse(env.payload);
    const outcome = await applySend(workerPort, mailer, notificationId);
    log.info("send_email_handled", { notificationId, outcome, traceId: env.traceId });
  };
}
```

- [ ] **Step 4: Run — expect PASS** + typecheck. `pnpm vitest run services/notification/src/__tests__/worker.unit.test.ts` ; `pnpm --filter @ecom/notification typecheck`
- [ ] **Step 5: Commit**

```bash
git add services/notification/src/worker.ts services/notification/src/__tests__/worker.unit.test.ts
git commit -m "feat(notification): worker (SendEmail -> render -> mail -> CAS SENT)"
```

---

### Task 7: main.ts wiring + compose (mailpit + notification + restart) + CI

**Files:**
- Create: `services/notification/src/main.ts`
- Modify: `docker-compose.example.yml`, `.github/workflows/ci.yml`

- [ ] **Step 1: main.ts** — `services/notification/src/main.ts` (Kafka consumer → dispatcher; relay routes SendEmail → rabbit `notifications`; rabbit worker consume; shutdown). Model on `services/order/src/main.ts`:

```ts
import { createApp } from "./app"; // clone payment's createApp({rabbitHealth}) — health only
import { config } from "./config";
import { outboxPort } from "./outbox-adapter";
import { handleOrderEvent } from "./dispatcher";
import { makeHandleSendEmail } from "./worker";
import { createMailer } from "./mailer";
import { prisma } from "./db";
import { createKafka, createProducer, createConsumer, startOutboxRelay, createRabbit, createLogger, gracefulShutdown } from "@ecom/shared";
import { SEND_EMAIL } from "./commands";

const log = createLogger("notification-main");
const QUEUE = "notifications";

async function main() {
  const kafka = createKafka("notification");
  const producer = createProducer(kafka);
  await producer.connect();

  const rabbit = await createRabbit({ prefetch: config.RABBIT_PREFETCH });
  await rabbit.assertWorkQueue(QUEUE);

  // Relay: SendEmail rows -> rabbit `notifications` (the only rows this service emits).
  const relay = startOutboxRelay(outboxPort, producer, (t) => `${t}.events`, {
    intervalMs: 500,
    commands: { sender: rabbit, queueFor: (r) => (r.type === SEND_EMAIL ? QUEUE : null) },
  });

  // Dispatcher: consume order.events.
  const consumer = createConsumer(kafka, "notification-dispatcher");
  await consumer.connect();
  await consumer.run(["order.events"], handleOrderEvent);

  // Worker: consume the notifications queue (prefetch-bounded).
  const mailer = createMailer({ host: config.SMTP_HOST, port: config.SMTP_PORT });
  await rabbit.consumeCommands(QUEUE, makeHandleSendEmail(mailer), { maxRetries: 3 });

  const app = createApp({ rabbitHealth: rabbit.checkHealth });
  const server = app.listen(config.PORT, () => log.info("notification_listening", { port: config.PORT }));

  gracefulShutdown([
    async () => { await prisma.$disconnect(); },
    async () => { await producer.disconnect(); },
    async () => { await rabbit.close(); },
    async () => { relay.stop(); },
    async () => { await consumer.disconnect(); },
    async () => { await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))); },
  ]);
}
main().catch((e) => { log.error("notification_fatal", { message: (e as Error).message }); process.exit(1); });
```
Also create `services/notification/src/app.ts` = clone `services/payment/src/app.ts` (health router with `db` + `rabbit` probes; NO business routes).

- [ ] **Step 2: Compose** — in `docker-compose.example.yml`:
  - Add a **mailpit** service (beside rabbitmq): `image: axllent/mailpit`, `ports: ["1025:1025","8025:8025"]`, `healthcheck: ["CMD","wget","-qO-","http://localhost:8025/livez"]` (or a tcp check), no profile (infra) OR under `app`.
  - Add a **notification** service under `app`: clone the `payment` block; `dockerfile: services/notification/Dockerfile`; `DATABASE_URL=…/notification`, `KAFKA_BROKERS`, `RABBITMQ_URL`, `SMTP_HOST: mailpit`, `SMTP_PORT: 1025`, `NOTIFY_EMAIL_DOMAIN: example.test`, `PORT 3005`, `ports:["3005:3005"]`; `depends_on` postgres+kafka+rabbitmq+mailpit healthy; healthcheck `/readyz`.
  - **Add `restart: unless-stopped` to every `app`-profile service** (hello/inventory/order/payment/catalog/notification) — the liveness-restart contract.

- [ ] **Step 3: CI** — add a `Notification service` step to `.github/workflows/ci.yml` (copy Payment; `DATABASE_URL=…/notification`, `KAFKA_BROKERS`, `RABBITMQ_URL`; `prisma migrate deploy` then `pnpm vitest run services/notification`).

- [ ] **Step 4: Typecheck + Order/Payment regression (main wiring compiles; shared unchanged since Task 1).** `pnpm --filter @ecom/notification typecheck` ; `pnpm vitest run --exclude "**/*.int.test.ts" --exclude "**/*.e2e.test.ts"` (unit suite green).
- [ ] **Step 5: Commit**

```bash
git add services/notification/src/main.ts services/notification/src/app.ts docker-compose.example.yml .github/workflows/ci.yml
git commit -m "feat(notification): wire dispatcher+relay+worker; compose mailpit+notification+restart; CI"
```

---

### Task 8: DLQ replay script + e2e (mailpit) + runbook + regression gate

**Files:**
- Create: `services/notification/scripts/replay-dlq.ts`, `services/notification/src/__tests__/notification.e2e.test.ts`, `docs/runbooks/phase-5-notification-demo.md`

- [ ] **Step 1: Replay script** — `services/notification/scripts/replay-dlq.ts`: connect rabbit, drain `notifications.dlq` (loop `consumeDlqOnce`-style via `ch.get`), re-`sendCommand` each envelope to `notifications`, log a count, close, exit. Keep it small + runnable via `pnpm --filter @ecom/notification exec tsx scripts/replay-dlq.ts`.

```ts
import { createRabbit, createLogger } from "@ecom/shared";
const log = createLogger("notification-replay");
async function main() {
  const rabbit = await createRabbit();
  let n = 0;
  // consumeDlqOnce returns one envelope or null; loop until dry.
  for (;;) {
    const env = await rabbit.consumeDlqOnce("notifications.dlq", 1000);
    if (!env) break;
    await rabbit.sendCommand("notifications", env);
    n++;
  }
  log.info("dlq_replayed", { count: n });
  await rabbit.close();
}
main().catch((e) => { log.error("replay_fatal", { message: (e as Error).message }); process.exit(1); });
```
> NOTE: `consumeDlqOnce` uses `ch.get(dlq, { noAck: true })` — it removes the message. Re-sending to `notifications` re-queues it for the worker. Idempotent-safe: the worker's row-status CAS means an already-SENT notification is skipped.

- [ ] **Step 2: e2e (real Kafka + Rabbit + mailpit + Postgres)** — `services/notification/src/__tests__/notification.e2e.test.ts`: publish an `order.confirmed` (with `userId`) to `order.events` via a real producer; run the dispatcher consumer + relay + the worker (real `createMailer` → mailpit) in-test (mirror `services/order/src/__tests__/order-payment-leg.e2e.test.ts` harness + start the worker via `rabbit.consumeCommands("notifications", makeHandleSendEmail(createMailer(...)))`); `waitFor` the `Notification` row `status==="SENT"`, then assert the email is in mailpit via `GET http://localhost:8025/api/v1/messages` (fetch; find the message to `<userId>@example.test`). Provide `waitFor`.

```ts
it("order.confirmed -> notification -> email in mailpit", async () => {
  const orderId = `o_${randomUUID()}`, userId = `u_${randomUUID()}`;
  await producer.publish("order.events", makeEnvelope({ type: ORDER_CONFIRMED, version: 1, traceId: "t", producer: "order", payload: { orderId, userId } }));
  await waitFor(async () => (await prisma.notification.findFirst({ where: { orderId } }))?.status === "SENT", 20000);
  const res = await fetch("http://localhost:8025/api/v1/messages");
  const body = await res.json();
  expect(JSON.stringify(body)).toContain(`${userId}@example.test`);
}, 30000);
```

- [ ] **Step 3: Run the e2e.** Requires **mailpit up**: `docker compose -f docker-compose.example.yml up -d mailpit` (its entry exists from Task 7). Then `DATABASE_URL='postgresql://ecom:ecom@localhost:5432/notification' pnpm vitest run services/notification/src/__tests__/notification.e2e.test.ts` → PASS.

- [ ] **Step 4: Runbook** — `docs/runbooks/phase-5-notification-demo.md`:

```md
# Phase 5 — manual demo (notification + mailpit + DLQ replay)

Prereq: `cp docker-compose.example.yml docker-compose.yml`, per-service env, images built.

1. `docker compose --profile app up -d`   # + mailpit (:8025 UI) + notification (:3005)
2. Place + confirm an order (per the Phase-3b demo). Open mailpit UI http://localhost:8025 →
   an "Order <id> confirmed" email to `<userId>@example.test`. The Notification row is SENT.
3. **DLQ demo:** `docker compose stop mailpit`. Confirm another order → the worker's send fails →
   after retries the SendEmail lands in `notifications.dlq` (the Notification row stays PENDING;
   check the rabbitmq UI http://localhost:15672 → `notifications.dlq` depth 1).
4. **Replay:** `docker compose start mailpit`; then
   `docker compose exec notification pnpm exec tsx scripts/replay-dlq.ts` (or run it host-side with
   RABBITMQ_URL set) → the message re-queues → the worker sends it → the email appears in mailpit,
   the row flips SENT.
5. `docker compose --profile app down`.
```

- [ ] **Step 5: Regression gate (per-service) + format + typecheck.**

Run each with its inline `DATABASE_URL`: `services/notification`, `services/order`, `services/payment`, `services/inventory`, `services/catalog`, `packages/shared`. Expected green EXCEPT the known pre-existing `services/inventory/src/__tests__/sweeper.int.test.ts` 2 (non-regression — sweeper/release unchanged). Anything else → real regression, report.
Run: `pnpm format` then `pnpm format:check`; `pnpm -r typecheck`. Clean.

- [ ] **Step 6: Commit**

```bash
git add services/notification/scripts/replay-dlq.ts services/notification/src/__tests__/notification.e2e.test.ts docs/runbooks/phase-5-notification-demo.md
git commit -m "test(5): notification e2e (mailpit) + DLQ replay script + demo runbook"
# if format changed files:
git add -u && git commit -m "style: prettier"
```

---

## Self-Review

**Spec coverage:**
- Rabbit hardening (prefetch + boot-retry + fail-fast + liveness-restart contract + dedup note) → Task 1 + Task 7 (`restart:`). `userId` widen → Task 2. Notification scaffold/schema → Task 3. Templates + Mailer(timeouts) + SendEmail → Task 4. Dispatcher (Postgres dedup, create+catch-P2002) → Task 5. Worker (CAS sent-marker) → Task 6. Wiring + mailpit + CI → Task 7. DLQ replay + e2e(mailpit) + runbook + regression → Task 8.
- Global constraints: prefetch/boot-retry/fail-fast (Task 1); `restart:` on all app services (Task 7); userId required (Task 2); dispatcher `create`+P2002 + `(orderId,type)` unique + markProcessed same-tx (Task 5); worker CAS PENDING→SENT (Task 6); Mailer timeouts (Task 4); recipient `<userId>@domain` (Task 5); ids-only logging (Tasks 5/6); migrations-CLI-only (Tasks 3); per-service regression (Task 8).

**Placeholder scan:** none — code/commands/expected output throughout. "Clone payment's X" names the exact sibling file. Task-8 e2e names the harness to mirror + the concrete mailpit assertion + the `waitFor` to provide.

**Type consistency:** `createRabbit(opts?)` (Task 1) consumed by notification `main` (Task 7) + Order/Payment (unchanged); `userId` payloads (Task 2) consumed by the dispatcher parse (Task 5); `DispatchTx`/`applyDispatch`/`handleOrderEvent` (Task 5) ↔ `dispatchTx` (Task 5); `renderTemplate` (Task 4) ↔ dispatcher (Task 5, subject) + worker (Task 6, subject+html); `Mailer`/`createMailer` (Task 4) ↔ worker (Task 6) + main (Task 7); `SEND_EMAIL`/`SendEmailPayloadSchema` (Task 4) ↔ dispatcher enqueue (Task 5) + worker parse (Task 6) + relay queueFor (Task 7); `WorkerPort`/`applySend`/`makeHandleSendEmail` (Task 6) ↔ main (Task 7).

**Infra:** Task 1 needs rabbit; 2 needs order DB; 3–6 need Postgres (notification/order DBs); 7 typecheck/unit only; 8 needs Postgres + Kafka + Rabbit + **mailpit** (controller brings mailpit up before Task 8). CI's integration job has Postgres/Kafka/Rabbit; add mailpit to the CI services for the notification step.
