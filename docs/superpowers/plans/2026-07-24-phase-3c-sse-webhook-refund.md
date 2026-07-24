# Phase 3c · SSE + async webhook/timeout + refund Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live SSE order-status stream, an asynchronous payment path (`%100==99` → `PROCESSING`, resolved by an inbound webhook), and an admin refund stub — closing Phase 3.

**Architecture:** Order streams transitions via Postgres `LISTEN/NOTIFY` — the transition `$transaction` fires `pg_notify` (write side, through Prisma), a dedicated `pg` client `LISTEN`s and fans out to an in-process subscriber registry (read side). Payment gains a `PROCESSING` outcome that emits nothing until `POST /webhooks/payment` finalizes it, plus a `POST /admin/payments/:orderId/refund` stub — both concurrent HTTP endpoints, so both use compare-and-set idempotency.

**Tech Stack:** TypeScript, Express, Prisma, KafkaJS + amqplib via `@ecom/shared`, zod via `@ecom/contracts`, **`pg` (node-postgres)** for the Order `LISTEN` client, Vitest + supertest + raw `http`.

**Reference spec:** `docs/superpowers/specs/2026-07-24-phase-3c-sse-webhook-refund-design.md`

## Global Constraints

- **Webhook + refund idempotency = compare-and-set** (`updateMany({ where: { orderId, status: <from> }, data: { status: <to> } })`, act only when `count === 1`). They are concurrent HTTP endpoints — no partition serialization — so read-then-write would double-emit.
- **SSE observation = Postgres `LISTEN/NOTIFY`**, single global channel `order_status`, in-app filter by `orderId`. NOTIFY via **tagged-template** `tx.$executeRaw` (bound param, never `$executeRawUnsafe`), inside the existing transition `$transaction` (delivered on commit). LISTEN via a dedicated `pg.Client` (Prisma cannot hold a LISTEN).
- **SSE listener failure = fail-fast liveness-restart** — on the `pg.Client` `error` event, log `sse_listener_down` and `process.exit(1)`; in-process reconnect is a Phase-5 deferral.
- **Terminal statuses** for the stream are `CONFIRMED` and `CANCELLED` (send frame → close). `REFUNDED` has no Order consumer this slice.
- **`ChargePayment.amount`/money** = integer minor units. `simulateCharge`: `%100==1`→FAILED, `%100==99`→PROCESSING, else SUCCEEDED.
- **Idempotency (Payment) unchanged** on the charge path: markProcessed-first + unique `Payment.orderId`.
- **Auth/signature** out of scope on SSE/webhook/refund (Phase 6). **Logging ids-only** (`orderId`, `outcome`, `traceId`, subscriber counts — never bodies/amounts-as-PII).
- **Migrations via CLI only** (comment-only for this slice — `String` columns). PascalCase models / camelCase fields / no `@map`.
- **Automated e2e is per-service legs with injected contract events** (two services can't share a Vitest process). SSE int test uses a raw `http` client (supertest can't stream `text/event-stream`).

---

## File Structure

- **Modify** `packages/contracts/src/events/payment.ts` (+`PAYMENT_REFUNDED`) + test.
- **Modify** `services/payment/src/charge.ts` (`simulateCharge`→PROCESSING, `chargeOrder` branch) + `__tests__/charge.unit.test.ts`. **Modify** `services/payment/prisma/schema.prisma` (status comments) + comment-only migration.
- **Create** `services/payment/src/resolve.ts` (`finalizePayment` + `refundPayment` cores). **Modify** `services/payment/src/tx-adapters.ts` (+`resolveTx`), `services/payment/src/app.ts` (+webhook + refund routes). **Create** `services/payment/src/__tests__/resolve.unit.test.ts`, `services/payment/src/__tests__/resolve.int.test.ts`.
- **Modify** `services/order/src/transition.ts` (+`notify` on `TransitionTx`, call in `applyResult`) + `__tests__/transition.unit.test.ts`; `services/order/src/tx-adapters.ts` (+`notify` impl).
- **Create** `services/order/src/sse-listener.ts` (`SubscriberRegistry` + `createOrderListener`) + `__tests__/sse-registry.unit.test.ts`. **Modify** `services/order/src/app.ts` (+`GET /orders/:id/stream`, `createApp` deps), `services/order/src/main.ts` (listener wiring), `services/order/package.json` (+`pg`). **Create** `services/order/src/__tests__/order-stream.int.test.ts`.
- **Create** `services/order/src/__tests__/order-stream.e2e.test.ts`, `services/payment/src/__tests__/webhook-refund.e2e.test.ts`, `docs/runbooks/phase-3c-sse-webhook-refund-demo.md`.

---

### Task 1: Contracts — `PAYMENT_REFUNDED`

**Files:**
- Modify: `packages/contracts/src/events/payment.ts`
- Test: `packages/contracts/src/__tests__/payment-refunded.test.ts`

**Interfaces — Produces:** `PAYMENT_REFUNDED = "payment.refunded"`; `PaymentRefundedPayloadSchema { orderId, paymentId, amount }` + type.

- [ ] **Step 1: Failing test** — create `packages/contracts/src/__tests__/payment-refunded.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PAYMENT_REFUNDED, PaymentRefundedPayloadSchema } from "../events/payment";

describe("payment.refunded contract", () => {
  it("has the expected type string", () => {
    expect(PAYMENT_REFUNDED).toBe("payment.refunded");
  });
  it("validates { orderId, paymentId, amount } and rejects bad input", () => {
    expect(
      PaymentRefundedPayloadSchema.parse({ orderId: "o1", paymentId: "p1", amount: 500 })
    ).toEqual({ orderId: "o1", paymentId: "p1", amount: 500 });
    expect(PaymentRefundedPayloadSchema.safeParse({ orderId: "o1" }).success).toBe(false);
    expect(
      PaymentRefundedPayloadSchema.safeParse({ orderId: "o1", paymentId: "p1", amount: 0 })
        .success
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `pnpm vitest run packages/contracts/src/__tests__/payment-refunded.test.ts`
- [ ] **Step 3: Implement** — append to `packages/contracts/src/events/payment.ts`:

```ts
export const PAYMENT_REFUNDED = "payment.refunded" as const;

export const PaymentRefundedPayloadSchema = z.object({
  orderId: z.string().min(1),
  paymentId: z.string().min(1),
  amount: z.number().int().positive(),
});
export type PaymentRefundedPayload = z.infer<typeof PaymentRefundedPayloadSchema>;
```

- [ ] **Step 4: Run — expect PASS.** `pnpm vitest run packages/contracts/src/__tests__/payment-refunded.test.ts`
- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/events/payment.ts packages/contracts/src/__tests__/payment-refunded.test.ts
git commit -m "feat(contracts): PaymentRefunded event"
```

---

### Task 2: Payment gateway — `PROCESSING` outcome + schema comments

**Files:**
- Modify: `services/payment/src/charge.ts`
- Modify: `services/payment/prisma/schema.prisma` (+ migration)
- Test: `services/payment/src/__tests__/charge.unit.test.ts`

**Interfaces — Produces:** `simulateCharge(amount): "SUCCEEDED" | "FAILED" | "PROCESSING"`; `ChargeOutcome` += `"PROCESSING"`; `chargeOrder` emits nothing on PROCESSING.

- [ ] **Step 1: Failing tests** — append to `services/payment/src/__tests__/charge.unit.test.ts` (keep existing cases; if it has a `fakeTx` helper reuse it — it must implement `markProcessed`, `paymentExists`, `createPayment`, `createAttempt`, `enqueue`):

```ts
import { CHARGE_PAYMENT, PAYMENT_SUCCEEDED, PAYMENT_FAILED } from "@ecom/contracts";
import { simulateCharge, chargeOrder, type ChargeTx } from "../charge";

describe("simulateCharge — PROCESSING (async timeout)", () => {
  it("routes %100==99 to PROCESSING, %100==1 to FAILED, else SUCCEEDED", () => {
    expect(simulateCharge(599)).toBe("PROCESSING");
    expect(simulateCharge(501)).toBe("FAILED");
    expect(simulateCharge(500)).toBe("SUCCEEDED");
  });
});

function fakeChargeTx(init?: { existing?: boolean }) {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const attempts: string[] = [];
  const processed = new Set<string>();
  let exists = init?.existing ?? false;
  const tx: ChargeTx = {
    async markProcessed(id) {
      if (processed.has(id)) return false;
      processed.add(id);
      return true;
    },
    async paymentExists() {
      return exists;
    },
    async createPayment() {
      exists = true;
      return "pay_1";
    },
    async createAttempt(_p, outcome) {
      attempts.push(outcome);
    },
    async enqueue(type, _o, payload) {
      emitted.push({ type, payload });
    },
  };
  return { tx, emitted, attempts };
}

describe("chargeOrder — PROCESSING branch", () => {
  it("records PROCESSING (payment + attempt) and emits NO event", async () => {
    const f = fakeChargeTx();
    const outcome = await chargeOrder(f.tx, { eventId: "e1", orderId: "o1", amount: 599 });
    expect(outcome).toBe("PROCESSING");
    expect(f.attempts).toEqual(["PROCESSING"]);
    expect(f.emitted).toEqual([]); // nothing published until the webhook resolves it
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`simulateCharge` returns no PROCESSING; `chargeOrder` has no PROCESSING branch). `pnpm vitest run services/payment/src/__tests__/charge.unit.test.ts`

- [ ] **Step 3: Implement** — edit `services/payment/src/charge.ts`:

Replace `simulateCharge`:

```ts
// Deterministic simulated gateway (no real money). Magic minor-units totals:
//   %100==1  -> FAILED (declined)
//   %100==99 -> PROCESSING (async — resolved later by POST /webhooks/payment)
//   else     -> SUCCEEDED
export function simulateCharge(amount: number): "SUCCEEDED" | "FAILED" | "PROCESSING" {
  if (amount % 100 === 1) return "FAILED";
  if (amount % 100 === 99) return "PROCESSING";
  return "SUCCEEDED";
}
```

Widen the outcome type and the emit branch:

```ts
export type ChargeOutcome =
  "DUPLICATE" | "ALREADY_CHARGED" | "SUCCEEDED" | "FAILED" | "PROCESSING";
```

In `chargeOrder`, replace the `if (outcome === "SUCCEEDED") { … } else { … }` block with:

```ts
  if (outcome === "SUCCEEDED") {
    await tx.enqueue(PAYMENT_SUCCEEDED, p.orderId, {
      orderId: p.orderId,
      paymentId,
      amount: p.amount,
    });
  } else if (outcome === "FAILED") {
    await tx.enqueue(PAYMENT_FAILED, p.orderId, {
      orderId: p.orderId,
      reason: "CARD_DECLINED",
    });
  }
  // PROCESSING: recorded (payment + attempt) but emits nothing — the inbound
  // webhook finalizes it later (Task 3).
  return outcome;
```

- [ ] **Step 4: Run — expect PASS.** `pnpm vitest run services/payment/src/__tests__/charge.unit.test.ts`

- [ ] **Step 5: Schema comments + comment-only migration** — in `services/payment/prisma/schema.prisma` update the two comments (no type change — both `String`):

```prisma
// status in {PROCESSING, SUCCEEDED, FAILED, REFUNDED}. orderId is the provider
// idempotency key; a retried ChargePayment cannot double-charge.
model Payment {
```

```prisma
// One row per gateway call/resolution. outcome in {PROCESSING, SUCCEEDED, FAILED, REFUNDED}.
model PaymentAttempt {
```

Run: `pnpm --filter @ecom/payment exec prisma migrate dev --name payment_processing_refunded`

> Comment-only ⇒ effectively-empty migration (as 3b's `reservation_consumed`). If Prisma says "no changes", create it with `--create-only` and leave the empty SQL so `migrate deploy` stays in lockstep. Document which you did in the report.

- [ ] **Step 6: Typecheck + Commit** `pnpm --filter @ecom/payment typecheck`

```bash
git add services/payment/src/charge.ts services/payment/src/__tests__/charge.unit.test.ts services/payment/prisma
git commit -m "feat(payment): simulateCharge PROCESSING outcome (async timeout) + schema comments"
```

---

### Task 3: Payment webhook — `finalizePayment` (CAS) + `POST /webhooks/payment`

**Files:**
- Create: `services/payment/src/resolve.ts`
- Modify: `services/payment/src/tx-adapters.ts` (+`resolveTx`), `services/payment/src/app.ts` (+route)
- Test: `services/payment/src/__tests__/resolve.unit.test.ts`, `services/payment/src/__tests__/resolve.int.test.ts`

**Interfaces — Produces:** `ResolveTx { loadPayment(orderId): Promise<{ paymentId: string; status: string; amount: number } | null>; casStatus(orderId, from, to): Promise<number>; createAttempt(paymentId, outcome): Promise<void>; enqueue(type, orderId, payload): Promise<void> }`; `finalizePayment(tx, { orderId, outcome }): Promise<"FINALIZED" | "NOOP" | "NOT_FOUND">`; `resolveTx(tx, traceId): ResolveTx`.

- [ ] **Step 1: Failing unit test** — create `services/payment/src/__tests__/resolve.unit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { finalizePayment, type ResolveTx } from "../resolve";
import { PAYMENT_SUCCEEDED, PAYMENT_FAILED } from "@ecom/contracts";

function fakeResolveTx(init: { status: string | null; amount?: number }) {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const attempts: string[] = [];
  let status = init.status;
  const tx: ResolveTx = {
    async loadPayment() {
      return status === null ? null : { paymentId: "pay_1", status, amount: init.amount ?? 500 };
    },
    async casStatus(_o, from, to) {
      if (status === from) { status = to; return 1; }
      return 0;
    },
    async createAttempt(_p, outcome) { attempts.push(outcome); },
    async enqueue(type, _o, payload) { emitted.push({ type, payload }); },
  };
  return { tx, emitted, attempts, statusNow: () => status };
}

describe("finalizePayment (webhook core)", () => {
  it("PROCESSING + SUCCEEDED -> FINALIZED, emits payment.succeeded(amount)", async () => {
    const f = fakeResolveTx({ status: "PROCESSING", amount: 700 });
    const r = await finalizePayment(f.tx, { orderId: "o1", outcome: "SUCCEEDED" });
    expect(r).toBe("FINALIZED");
    expect(f.statusNow()).toBe("SUCCEEDED");
    expect(f.attempts).toEqual(["SUCCEEDED"]);
    expect(f.emitted).toEqual([
      { type: PAYMENT_SUCCEEDED, payload: { orderId: "o1", paymentId: "pay_1", amount: 700 } },
    ]);
  });
  it("PROCESSING + FAILED -> FINALIZED, emits payment.failed(reason)", async () => {
    const f = fakeResolveTx({ status: "PROCESSING" });
    const r = await finalizePayment(f.tx, { orderId: "o1", outcome: "FAILED" });
    expect(r).toBe("FINALIZED");
    expect(f.emitted).toEqual([
      { type: PAYMENT_FAILED, payload: { orderId: "o1", reason: "WEBHOOK_DECLINED" } },
    ]);
  });
  it("already SUCCEEDED -> NOOP, no event (idempotent / concurrent webhook)", async () => {
    const f = fakeResolveTx({ status: "SUCCEEDED" });
    expect(await finalizePayment(f.tx, { orderId: "o1", outcome: "SUCCEEDED" })).toBe("NOOP");
    expect(f.emitted).toEqual([]);
  });
  it("unknown order -> NOT_FOUND", async () => {
    const f = fakeResolveTx({ status: null });
    expect(await finalizePayment(f.tx, { orderId: "x", outcome: "SUCCEEDED" })).toBe("NOT_FOUND");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`resolve.ts` missing). `pnpm vitest run services/payment/src/__tests__/resolve.unit.test.ts`

- [ ] **Step 3a: Implement the core** — create `services/payment/src/resolve.ts`:

```ts
import { PAYMENT_SUCCEEDED, PAYMENT_FAILED, PAYMENT_REFUNDED } from "@ecom/contracts";

export interface ResolveTx {
  loadPayment(orderId: string): Promise<{ paymentId: string; status: string; amount: number } | null>;
  // Conditional status write; returns rows changed (1 = we won, 0 = someone else did).
  casStatus(orderId: string, from: string, to: string): Promise<number>;
  createAttempt(paymentId: string, outcome: string): Promise<void>;
  enqueue(type: string, orderId: string, payload: unknown): Promise<void>;
}

// Inbound webhook resolves a PROCESSING payment. Compare-and-set guards concurrent
// webhooks: only the caller that flips PROCESSING->outcome (count 1) emits.
export async function finalizePayment(
  tx: ResolveTx,
  p: { orderId: string; outcome: "SUCCEEDED" | "FAILED" }
): Promise<"FINALIZED" | "NOOP" | "NOT_FOUND"> {
  const payment = await tx.loadPayment(p.orderId);
  if (payment === null) return "NOT_FOUND";

  const won = await tx.casStatus(p.orderId, "PROCESSING", p.outcome);
  if (won === 0) return "NOOP"; // already finalized, or was never PROCESSING

  await tx.createAttempt(payment.paymentId, p.outcome);
  if (p.outcome === "SUCCEEDED") {
    await tx.enqueue(PAYMENT_SUCCEEDED, p.orderId, {
      orderId: p.orderId,
      paymentId: payment.paymentId,
      amount: payment.amount,
    });
  } else {
    await tx.enqueue(PAYMENT_FAILED, p.orderId, {
      orderId: p.orderId,
      reason: "WEBHOOK_DECLINED",
    });
  }
  return "FINALIZED";
}

// Admin refund stub — reused Task 4. Kept here so webhook + refund share ResolveTx.
export async function refundPayment(
  tx: ResolveTx,
  p: { orderId: string }
): Promise<"REFUNDED" | "NOOP" | "NOT_FOUND" | "NOT_REFUNDABLE"> {
  const payment = await tx.loadPayment(p.orderId);
  if (payment === null) return "NOT_FOUND";
  if (payment.status === "REFUNDED") return "NOOP";
  if (payment.status !== "SUCCEEDED") return "NOT_REFUNDABLE";

  const won = await tx.casStatus(p.orderId, "SUCCEEDED", "REFUNDED");
  if (won === 0) return "NOOP"; // concurrent refund already won

  await tx.createAttempt(payment.paymentId, "REFUNDED");
  await tx.enqueue(PAYMENT_REFUNDED, p.orderId, {
    orderId: p.orderId,
    paymentId: payment.paymentId,
    amount: payment.amount,
  });
  return "REFUNDED";
}
```

- [ ] **Step 3b: Port** — append `resolveTx` to `services/payment/src/tx-adapters.ts`:

```ts
import type { ResolveTx } from "./resolve";

export function resolveTx(tx: Prisma.TransactionClient, traceId: string): ResolveTx {
  return {
    async loadPayment(orderId) {
      const row = await tx.payment.findUnique({
        where: { orderId },
        select: { id: true, status: true, amount: true },
      });
      return row ? { paymentId: row.id, status: row.status, amount: row.amount } : null;
    },
    async casStatus(orderId, from, to) {
      const r = await tx.payment.updateMany({
        where: { orderId, status: from },
        data: { status: to },
      });
      return r.count;
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

- [ ] **Step 3c: Route** — in `services/payment/src/app.ts`, add zod + the webhook route (inside `createApp`, after the `GET /payments/:orderId` route). Add imports at top:

```ts
import { z } from "zod";
import { finalizePayment } from "./resolve";
import { resolveTx } from "./tx-adapters";
```

```ts
  const WebhookSchema = z.object({
    orderId: z.string().min(1),
    outcome: z.enum(["SUCCEEDED", "FAILED"]),
  });

  // Simulated-provider callback resolving a PROCESSING payment. Unauthenticated
  // (Phase 6 gateway / HMAC later). Concurrent-safe via compare-and-set.
  app.post("/webhooks/payment", async (req, res) => {
    const parsed = WebhookSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid webhook" });
    const { orderId, outcome } = parsed.data;
    try {
      const r = await prisma.$transaction((tx) =>
        finalizePayment(resolveTx(tx, req.traceId), { orderId, outcome })
      );
      if (r === "NOT_FOUND") return res.status(404).json({ error: "not found" });
      log.info("webhook_resolved", { orderId, outcome, result: r, traceId: req.traceId });
      return res.status(200).json({ orderId, result: r }); // FINALIZED or NOOP
    } catch {
      log.error("webhook_failed", { orderId, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });
```

- [ ] **Step 4: Failing int test** — create `services/payment/src/__tests__/resolve.int.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { prisma } from "../db";
import { PAYMENT_SUCCEEDED, PAYMENT_FAILED } from "@ecom/contracts";

const app = createApp({ rabbitHealth: async () => {} });
const seedProcessing = async (amount = 599): Promise<string> => {
  const orderId = `o_${randomUUID()}`;
  await prisma.payment.create({ data: { orderId, amount, status: "PROCESSING" } });
  return orderId;
};
const outbox = (orderId: string, type: string) =>
  prisma.outbox.count({ where: { aggregateId: orderId, type } });
const statusOf = async (orderId: string) =>
  (await prisma.payment.findUnique({ where: { orderId } }))?.status;

describe("payment webhook (integration — needs compose up + migrated)", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("SUCCEEDED webhook finalizes a PROCESSING payment + emits payment.succeeded", async () => {
    const orderId = await seedProcessing();
    const res = await request(app).post("/webhooks/payment").send({ orderId, outcome: "SUCCEEDED" });
    expect(res.status).toBe(200);
    expect(await statusOf(orderId)).toBe("SUCCEEDED");
    expect(await outbox(orderId, PAYMENT_SUCCEEDED)).toBe(1);
  });

  it("FAILED webhook emits payment.failed", async () => {
    const orderId = await seedProcessing();
    await request(app).post("/webhooks/payment").send({ orderId, outcome: "FAILED" });
    expect(await statusOf(orderId)).toBe("FAILED");
    expect(await outbox(orderId, PAYMENT_FAILED)).toBe(1);
  });

  it("redelivered webhook is an idempotent no-op (one event)", async () => {
    const orderId = await seedProcessing();
    await request(app).post("/webhooks/payment").send({ orderId, outcome: "SUCCEEDED" });
    const res2 = await request(app).post("/webhooks/payment").send({ orderId, outcome: "SUCCEEDED" });
    expect(res2.status).toBe(200);
    expect(await outbox(orderId, PAYMENT_SUCCEEDED)).toBe(1);
  });

  it("unknown order -> 404; malformed body -> 400", async () => {
    const r404 = await request(app).post("/webhooks/payment").send({ orderId: `o_${randomUUID()}`, outcome: "SUCCEEDED" });
    expect(r404.status).toBe(404);
    const r400 = await request(app).post("/webhooks/payment").send({ orderId: "o1" });
    expect(r400.status).toBe(400);
  });
});
```

- [ ] **Step 5: Migrate + run int test + typecheck.**

Run: `pnpm --filter @ecom/payment exec prisma migrate deploy`
Run: `pnpm vitest run services/payment/src/__tests__/resolve.unit.test.ts services/payment/src/__tests__/resolve.int.test.ts`
Run: `pnpm --filter @ecom/payment typecheck`
Expected: unit 4 + int 4 PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add services/payment/src/resolve.ts services/payment/src/tx-adapters.ts services/payment/src/app.ts services/payment/src/__tests__/resolve.unit.test.ts services/payment/src/__tests__/resolve.int.test.ts
git commit -m "feat(payment): async webhook finalizes PROCESSING payment (compare-and-set)"
```

---

### Task 4: Payment refund stub — `POST /admin/payments/:orderId/refund`

**Files:**
- Modify: `services/payment/src/app.ts` (+route; `refundPayment` + `resolveTx` already exist from Task 3)
- Test: extend `services/payment/src/__tests__/resolve.unit.test.ts`, `services/payment/src/__tests__/resolve.int.test.ts`

**Interfaces — Consumes:** `refundPayment` (Task 3 `resolve.ts`), `resolveTx` (Task 3).

- [ ] **Step 1: Failing unit tests** — append to `resolve.unit.test.ts`:

```ts
import { refundPayment } from "../resolve";
import { PAYMENT_REFUNDED } from "@ecom/contracts";

describe("refundPayment (admin stub core)", () => {
  it("SUCCEEDED -> REFUNDED + emits payment.refunded(amount)", async () => {
    const f = fakeResolveTx({ status: "SUCCEEDED", amount: 700 });
    expect(await refundPayment(f.tx, { orderId: "o1" })).toBe("REFUNDED");
    expect(f.statusNow()).toBe("REFUNDED");
    expect(f.emitted).toEqual([
      { type: PAYMENT_REFUNDED, payload: { orderId: "o1", paymentId: "pay_1", amount: 700 } },
    ]);
  });
  it("already REFUNDED -> NOOP, no event", async () => {
    const f = fakeResolveTx({ status: "REFUNDED" });
    expect(await refundPayment(f.tx, { orderId: "o1" })).toBe("NOOP");
    expect(f.emitted).toEqual([]);
  });
  it("PROCESSING/FAILED -> NOT_REFUNDABLE", async () => {
    const f = fakeResolveTx({ status: "PROCESSING" });
    expect(await refundPayment(f.tx, { orderId: "o1" })).toBe("NOT_REFUNDABLE");
  });
  it("unknown order -> NOT_FOUND", async () => {
    const f = fakeResolveTx({ status: null });
    expect(await refundPayment(f.tx, { orderId: "x" })).toBe("NOT_FOUND");
  });
});
```

- [ ] **Step 2: Run — expect PASS** (`refundPayment` already implemented in Task 3). `pnpm vitest run services/payment/src/__tests__/resolve.unit.test.ts`

> If Task 3 and Task 4 are done by the same worker, these unit cases pass immediately — the RED was Task 3's Step 2 (the file didn't exist). Add them now for the refund route's coverage before wiring it.

- [ ] **Step 3: Route** — in `services/payment/src/app.ts`, add (after the webhook route). Import `refundPayment`:

```ts
import { finalizePayment, refundPayment } from "./resolve";
```

```ts
  // Admin refund stub — marks a SUCCEEDED payment REFUNDED and emits payment.refunded.
  // No consumer this slice. Unauthenticated (Phase 6). Concurrent-safe via CAS.
  app.post("/admin/payments/:orderId/refund", async (req, res) => {
    const { orderId } = req.params;
    try {
      const r = await prisma.$transaction((tx) =>
        refundPayment(resolveTx(tx, req.traceId), { orderId })
      );
      if (r === "NOT_FOUND") return res.status(404).json({ error: "not found" });
      if (r === "NOT_REFUNDABLE")
        return res.status(409).json({ error: "not refundable", orderId });
      log.info("refund_handled", { orderId, result: r, traceId: req.traceId });
      return res.status(200).json({ orderId, result: r }); // REFUNDED or NOOP
    } catch {
      log.error("refund_failed", { orderId, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });
```

- [ ] **Step 4: Failing int test** — append to `resolve.int.test.ts`:

```ts
import { PAYMENT_REFUNDED } from "@ecom/contracts";

async function seedSucceeded(amount = 500): Promise<string> {
  const orderId = `o_${randomUUID()}`;
  await prisma.payment.create({ data: { orderId, amount, status: "SUCCEEDED" } });
  return orderId;
}

describe("payment refund (integration)", () => {
  it("refunds a SUCCEEDED payment + emits payment.refunded", async () => {
    const orderId = await seedSucceeded();
    const res = await request(app).post(`/admin/payments/${orderId}/refund`).send();
    expect(res.status).toBe(200);
    expect(await statusOf(orderId)).toBe("REFUNDED");
    expect(await outbox(orderId, PAYMENT_REFUNDED)).toBe(1);
  });
  it("double refund is idempotent (one event)", async () => {
    const orderId = await seedSucceeded();
    await request(app).post(`/admin/payments/${orderId}/refund`).send();
    const res2 = await request(app).post(`/admin/payments/${orderId}/refund`).send();
    expect(res2.status).toBe(200);
    expect(await outbox(orderId, PAYMENT_REFUNDED)).toBe(1);
  });
  it("refunding a PROCESSING payment -> 409; unknown -> 404", async () => {
    const proc = await seedProcessing();
    expect((await request(app).post(`/admin/payments/${proc}/refund`).send()).status).toBe(409);
    expect((await request(app).post(`/admin/payments/o_${randomUUID()}/refund`).send()).status).toBe(404);
  });
});
```

- [ ] **Step 5: Run int + typecheck.**

Run: `pnpm vitest run services/payment/src/__tests__/resolve.int.test.ts`
Run: `pnpm --filter @ecom/payment typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add services/payment/src/app.ts services/payment/src/__tests__/resolve.unit.test.ts services/payment/src/__tests__/resolve.int.test.ts
git commit -m "feat(payment): admin refund stub -> payment.refunded (compare-and-set)"
```

---

### Task 5: Order transition — `NOTIFY` on every status change

**Files:**
- Modify: `services/order/src/transition.ts` (+`notify` on `TransitionTx`, call in `applyResult`), `services/order/src/tx-adapters.ts` (+`notify` impl)
- Test: `services/order/src/__tests__/transition.unit.test.ts` (extend the `fakeTx`)

**Interfaces — Produces:** `TransitionTx` += `notify(orderId, status): Promise<void>`; `applyResult` calls `notify` after each `setStatus`.

- [ ] **Step 1: Extend the unit test** — in `services/order/src/__tests__/transition.unit.test.ts`, add `notify` to the `fakeTx` factory and assert it fires. Add to the `fakeTx` returned object a `notified` array and the port method:

```ts
  // inside fakeTx(): add before `const tx: TransitionTx = {`
  const notified: Array<{ orderId: string; status: string }> = [];
  // add inside the tx object literal:
    async notify(orderId, status) { notified.push({ orderId, status }); },
  // add to the returned object:
  return { tx, emitted, processed, notified, statusNow: () => status };
```

Add a test:

```ts
it("emits a NOTIFY with the new status on each transition", async () => {
  const f = fakeTx({ status: "AWAITING_PAYMENT" });
  await applyResult(f.tx, { eventId: "n1", type: PAYMENT_SUCCEEDED, orderId: "o9" });
  expect(f.notified).toEqual([{ orderId: "o9", status: "CONFIRMED" }]);
});
it("does not NOTIFY on a guarded NO_OP", async () => {
  const f = fakeTx({ status: "CONFIRMED" });
  await applyResult(f.tx, { eventId: "n2", type: PAYMENT_SUCCEEDED, orderId: "o9" });
  expect(f.notified).toEqual([]);
});
```

- [ ] **Step 2: Run — expect FAIL** (`notify` not on `TransitionTx`; TS error + assertion). `pnpm vitest run services/order/src/__tests__/transition.unit.test.ts`

- [ ] **Step 3a: Interface + call** — in `services/order/src/transition.ts`, add to the `TransitionTx` interface:

```ts
  notify(orderId: string, status: OrderStatus): Promise<void>;
```

In `applyResult`, right after `await tx.setStatus(p.orderId, next);` add:

```ts
  await tx.notify(p.orderId, next); // SSE: pg_notify on commit (Task 6/7 fan-out)
```

- [ ] **Step 3b: Impl** — in `services/order/src/tx-adapters.ts` `transitionTx`, add (after `setStatus`):

```ts
    async notify(orderId, status) {
      // Bound-param tagged template (never $executeRawUnsafe). NOTIFY inside this
      // tx is delivered on COMMIT — as atomic as setStatus, dropped on rollback.
      await tx.$executeRaw`SELECT pg_notify('order_status', ${JSON.stringify({
        orderId,
        status,
      })})`;
    },
```

- [ ] **Step 4: Run — expect PASS** (transition unit). `pnpm vitest run services/order/src/__tests__/transition.unit.test.ts`
- [ ] **Step 5: Typecheck** `pnpm --filter @ecom/order typecheck`
- [ ] **Step 6: Commit**

```bash
git add services/order/src/transition.ts services/order/src/tx-adapters.ts services/order/src/__tests__/transition.unit.test.ts
git commit -m "feat(order): pg_notify order_status on every transition (SSE write side)"
```

---

### Task 6: Order SSE — subscriber registry + LISTEN client

**Files:**
- Create: `services/order/src/sse-listener.ts`
- Modify: `services/order/package.json` (+`pg`, +`@types/pg`)
- Test: `services/order/src/__tests__/sse-registry.unit.test.ts`

**Interfaces — Produces:** `type StatusFrame = { orderId: string; status: string }`; `interface Sink { send(f: StatusFrame): void; end(): void }`; `class SubscriberRegistry { subscribe(orderId, sink): () => void; unsubscribe(orderId, sink): void; dispatch(frame): void; size(orderId): number }`; `createOrderListener(databaseUrl): { registry: SubscriberRegistry; start(): Promise<void>; close(): Promise<void> }`.

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @ecom/order add pg && pnpm --filter @ecom/order add -D @types/pg`

- [ ] **Step 2: Failing unit test** — create `services/order/src/__tests__/sse-registry.unit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SubscriberRegistry, type Sink, type StatusFrame } from "../sse-listener";

function fakeSink() {
  const sent: StatusFrame[] = [];
  let ended = false;
  const sink: Sink = { send: (f) => sent.push(f), end: () => { ended = true; } };
  return { sink, sent, ended: () => ended };
}

describe("SubscriberRegistry", () => {
  it("dispatches a frame only to that order's subscribers", () => {
    const r = new SubscriberRegistry();
    const a = fakeSink(), b = fakeSink();
    r.subscribe("o1", a.sink);
    r.subscribe("o2", b.sink);
    r.dispatch({ orderId: "o1", status: "AWAITING_PAYMENT" });
    expect(a.sent).toEqual([{ orderId: "o1", status: "AWAITING_PAYMENT" }]);
    expect(b.sent).toEqual([]);
  });
  it("fans out to multiple subscribers of one order", () => {
    const r = new SubscriberRegistry();
    const a = fakeSink(), b = fakeSink();
    r.subscribe("o1", a.sink);
    r.subscribe("o1", b.sink);
    r.dispatch({ orderId: "o1", status: "AWAITING_PAYMENT" });
    expect(a.sent.length).toBe(1);
    expect(b.sent.length).toBe(1);
  });
  it("ends + removes subscribers on a terminal status", () => {
    const r = new SubscriberRegistry();
    const a = fakeSink();
    r.subscribe("o1", a.sink);
    r.dispatch({ orderId: "o1", status: "CONFIRMED" });
    expect(a.ended()).toBe(true);
    expect(r.size("o1")).toBe(0);
  });
  it("does not end on a non-terminal status", () => {
    const r = new SubscriberRegistry();
    const a = fakeSink();
    r.subscribe("o1", a.sink);
    r.dispatch({ orderId: "o1", status: "AWAITING_PAYMENT" });
    expect(a.ended()).toBe(false);
    expect(r.size("o1")).toBe(1);
  });
  it("unsubscribe() stops further frames", () => {
    const r = new SubscriberRegistry();
    const a = fakeSink();
    const off = r.subscribe("o1", a.sink);
    off();
    r.dispatch({ orderId: "o1", status: "AWAITING_PAYMENT" });
    expect(a.sent).toEqual([]);
    expect(r.size("o1")).toBe(0);
  });
});
```

- [ ] **Step 3: Run — expect FAIL** (`sse-listener.ts` missing). `pnpm vitest run services/order/src/__tests__/sse-registry.unit.test.ts`

- [ ] **Step 4: Implement** — create `services/order/src/sse-listener.ts`:

```ts
import { Client } from "pg";
import { createLogger } from "@ecom/shared";

const log = createLogger("order-sse");

export type StatusFrame = { orderId: string; status: string };
export interface Sink {
  send(frame: StatusFrame): void;
  end(): void;
}

const TERMINAL = new Set(["CONFIRMED", "CANCELLED"]);

// Pure fan-out: orderId -> set of sinks. No I/O, unit-testable.
export class SubscriberRegistry {
  private map = new Map<string, Set<Sink>>();

  subscribe(orderId: string, sink: Sink): () => void {
    let set = this.map.get(orderId);
    if (!set) {
      set = new Set();
      this.map.set(orderId, set);
    }
    set.add(sink);
    return () => this.unsubscribe(orderId, sink);
  }

  unsubscribe(orderId: string, sink: Sink): void {
    const set = this.map.get(orderId);
    if (!set) return;
    set.delete(sink);
    if (set.size === 0) this.map.delete(orderId);
  }

  dispatch(frame: StatusFrame): void {
    const set = this.map.get(frame.orderId);
    if (!set) return;
    const terminal = TERMINAL.has(frame.status);
    for (const sink of [...set]) {
      sink.send(frame);
      if (terminal) {
        sink.end();
        this.unsubscribe(frame.orderId, sink);
      }
    }
  }

  size(orderId: string): number {
    return this.map.get(orderId)?.size ?? 0;
  }
}

// The dedicated LISTEN connection (Prisma can't hold a LISTEN). Fans NOTIFY
// payloads into the registry. Fail-fast on error (liveness-restart; reconnect = P5).
export function createOrderListener(databaseUrl: string) {
  const registry = new SubscriberRegistry();
  const client = new Client({ connectionString: databaseUrl });

  async function start(): Promise<void> {
    await client.connect();
    await client.query("LISTEN order_status");
    client.on("notification", (msg) => {
      if (!msg.payload) return;
      try {
        registry.dispatch(JSON.parse(msg.payload) as StatusFrame);
      } catch (e) {
        log.error("sse_bad_notify", { message: (e as Error).message });
      }
    });
    client.on("error", (e) => {
      log.error("sse_listener_down", { message: (e as Error).message });
      process.exit(1); // container restart re-establishes; clients auto-reconnect
    });
    log.info("sse_listener_started", {});
  }

  async function close(): Promise<void> {
    await client.end().catch(() => {});
  }

  return { registry, start, close };
}
```

- [ ] **Step 5: Run — expect PASS** (5 cases) + typecheck. `pnpm vitest run services/order/src/__tests__/sse-registry.unit.test.ts` ; `pnpm --filter @ecom/order typecheck`
- [ ] **Step 6: Commit**

```bash
git add services/order/package.json services/order/src/sse-listener.ts services/order/src/__tests__/sse-registry.unit.test.ts
git commit -m "feat(order): SSE subscriber registry + pg LISTEN client (fail-fast)"
```

> `pnpm-lock.yaml` also changed (new dep). Stage it too: `git add pnpm-lock.yaml` before the commit.

---

### Task 7: Order SSE endpoint + main wiring

**Files:**
- Modify: `services/order/src/app.ts` (`createApp` gains an optional `sseRegistry` dep; `GET /orders/:id/stream`), `services/order/src/main.ts` (listener start + shutdown)
- Test: `services/order/src/__tests__/order-stream.int.test.ts`

**Interfaces — Consumes:** `SubscriberRegistry`, `Sink` (Task 6). **Produces:** `createApp(deps?: { sseRegistry?: SubscriberRegistry })`.

- [ ] **Step 1: `createApp` deps + stream route** — in `services/order/src/app.ts`:

Change the signature and import:

```ts
import { SubscriberRegistry, type Sink } from "./sse-listener";

export function createApp(deps: { sseRegistry?: SubscriberRegistry } = {}): express.Application {
```

Add the route after `app.get("/orders/:id", …)`:

```ts
  // Live order-status stream (SSE). One frame per transition; closes on terminal.
  app.get("/orders/:id/stream", async (req, res) => {
    const registry = deps.sseRegistry;
    if (!registry) return res.status(503).json({ error: "stream unavailable" });
    const id = req.params.id;

    // 404 before any SSE headers.
    const exists = await prisma.order.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return res.status(404).json({ error: "not found" });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const sink: Sink = {
      send: (f) => res.write(`event: status\ndata: ${JSON.stringify(f)}\n\n`),
      end: () => res.end(),
    };
    // Register BEFORE reading current status so a transition landing during the
    // read is still delivered (a rare initial==first-notify overlap is deduped
    // client-side by status).
    const unsubscribe = registry.subscribe(id, sink);

    const current = await prisma.order.findUnique({ where: { id }, select: { status: true } });
    if (!res.writableEnded && current) {
      sink.send({ orderId: id, status: current.status });
      if (current.status === "CONFIRMED" || current.status === "CANCELLED") {
        unsubscribe();
        return res.end();
      }
    }

    const heartbeat = setInterval(() => res.write(":keepalive\n\n"), 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
```

- [ ] **Step 2: Wire main.ts** — in `services/order/src/main.ts`: import the listener, start it, pass its registry to `createApp`, and add `close()` to shutdown. Add import:

```ts
import { createOrderListener } from "./sse-listener";
import { config } from "./config"; // already imported — DATABASE_URL lives here? see note
```

> `config` currently validates `DATABASE_URL` (3b Task 6 added the config schema). Use `config.DATABASE_URL`. If it is not in the schema, add `DATABASE_URL: z.string().url()` to `services/order/src/config.ts` in this step.

In `main()`, after `const rabbit = await createRabbit();` (and its `assertWorkQueue`), add:

```ts
  const listener = createOrderListener(config.DATABASE_URL);
  await listener.start();
```

Change `const app = createApp();` to:

```ts
  const app = createApp({ sseRegistry: listener.registry });
```

Add `listener.close()` to the shutdown array so it runs after `server.close` (open streams end) and before `prisma.$disconnect`. Insert this entry just above the `prisma.$disconnect` entry (recall the array executes in reverse — top runs last):

```ts
    async () => {
      await prisma.$disconnect();
    },
    async () => {
      await listener.close();
    },
```

Update the teardown comment to include `-> listener.close -> prisma.$disconnect`.

- [ ] **Step 3: Failing int test** — create `services/order/src/__tests__/order-stream.int.test.ts` (raw `http` — supertest can't stream SSE):

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { createOrderListener } from "../sse-listener";
import { handleEvent } from "../consumer";
import { prisma } from "../db";
import { config } from "../config";
import { makeEnvelope, PAYMENT_SUCCEEDED } from "@ecom/contracts";

const listener = createOrderListener(config.DATABASE_URL);
const app = createApp({ sseRegistry: listener.registry });
let server: http.Server;
let baseUrl: string;

async function seedOrder(status: string, totalPrice = 500): Promise<string> {
  const o = await prisma.order.create({
    data: {
      userId: `u_${randomUUID()}`,
      status,
      totalPrice,
      items: { create: [{ productId: `p_${randomUUID()}`, quantity: 1, unitPrice: totalPrice }] },
    },
  });
  return o.id;
}

// Collect SSE data frames until `until` matches or a deadline; then destroy.
function streamFrames(path: string, until: (s: string) => boolean, ms = 8000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}${path}`, (res) => {
      const frames: any[] = [];
      let buf = "";
      const timer = setTimeout(() => { req.destroy(); resolve(frames); }, ms);
      res.on("data", (chunk) => {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (line) {
            const frame = JSON.parse(line.slice(6));
            frames.push(frame);
            if (until(frame.status)) { clearTimeout(timer); req.destroy(); resolve(frames); }
          }
        }
      });
      res.on("error", () => {});
    });
    req.on("error", reject);
  });
}

describe("order SSE stream (integration — needs compose up + migrated)", () => {
  beforeAll(async () => {
    await listener.start();
    await new Promise<void>((r) => { server = app.listen(0, () => r()); });
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await listener.close();
    await prisma.$disconnect();
  });

  it("streams the initial status then a live transition, and closes on terminal", async () => {
    const id = await seedOrder("AWAITING_PAYMENT");
    const framesP = streamFrames(`/orders/${id}/stream`, (s) => s === "CONFIRMED");
    await new Promise((r) => setTimeout(r, 300)); // let the stream subscribe
    await handleEvent(
      makeEnvelope({
        type: PAYMENT_SUCCEEDED, version: 1, traceId: "t", producer: "payment",
        payload: { orderId: id, paymentId: "pay_1", amount: 500 },
      })
    );
    const frames = await framesP;
    const statuses = frames.map((f) => f.status);
    expect(statuses[0]).toBe("AWAITING_PAYMENT"); // initial
    expect(statuses).toContain("CONFIRMED");      // live transition
  }, 15000);

  it("404 for an unknown order", async () => {
    const status = await new Promise<number>((resolve) => {
      http.get(`${baseUrl}/orders/o_${randomUUID()}/stream`, (res) => {
        resolve(res.statusCode ?? 0);
        res.destroy();
      });
    });
    expect(status).toBe(404);
  });
});
```

- [ ] **Step 4: Migrate (if needed) + run int test + typecheck.**

Run: `pnpm --filter @ecom/order exec prisma migrate deploy`
Run: `pnpm vitest run services/order/src/__tests__/order-stream.int.test.ts`
Run: `pnpm --filter @ecom/order typecheck`
Expected: PASS (2), clean.

- [ ] **Step 5: Whole Order + Payment unit suite (no regressions from the createApp signature change).**

Run: `pnpm vitest run --exclude "**/*.int.test.ts" --exclude "**/*.e2e.test.ts"`
Expected: all green (existing `createApp()` callers still compile — the dep is optional).

- [ ] **Step 6: Commit**

```bash
git add services/order/src/app.ts services/order/src/main.ts services/order/src/config.ts services/order/src/__tests__/order-stream.int.test.ts
git commit -m "feat(order): GET /orders/:id/stream (SSE) + listener wiring"
```

---

### Task 8: Per-leg e2e + runbook + regression gate

**Files:**
- Create: `services/payment/src/__tests__/webhook-refund.e2e.test.ts`, `services/order/src/__tests__/order-stream.e2e.test.ts`, `docs/runbooks/phase-3c-sse-webhook-refund-demo.md`

- [ ] **Step 1: Payment async e2e** — create `services/payment/src/__tests__/webhook-refund.e2e.test.ts` (real Kafka relay + Rabbit consume, the standalone Payment path from 3a extended: a `%100==99` ChargePayment lands PROCESSING and emits nothing until the webhook). Model it on the existing `services/payment/src/__tests__/payment.e2e.test.ts` — reuse its harness (createKafka/createProducer/consumer + createRabbit + startOutboxRelay), adding:

```ts
// after sending a ChargePayment with amount 599 and asserting Payment.status PROCESSING
// (no payment.events row yet), POST the webhook and assert payment.succeeded is emitted:
it("timeout leg: %100==99 -> PROCESSING (no event) -> webhook -> payment.succeeded", async () => {
  const orderId = `o_${randomUUID()}`;
  await rabbit.sendCommand("payment.charge", makeEnvelope({
    type: CHARGE_PAYMENT, version: 1, traceId: "t", producer: "order",
    payload: { orderId, amount: 599 },
  }));
  await waitFor(async () => (await prisma.payment.findUnique({ where: { orderId } }))?.status === "PROCESSING");
  expect(await prisma.outbox.count({ where: { aggregateId: orderId, type: PAYMENT_SUCCEEDED } })).toBe(0);
  await request(createApp({ rabbitHealth: async () => {} }))
    .post("/webhooks/payment").send({ orderId, outcome: "SUCCEEDED" });
  await waitFor(async () =>
    (await prisma.outbox.count({ where: { aggregateId: orderId, type: PAYMENT_SUCCEEDED } })) === 1);
});
```

> Provide a small `waitFor(pred, ms=10000, step=250)` poll helper in the test (loop `await pred()` with `setTimeout`). Copy the connect/teardown scaffold verbatim from `payment.e2e.test.ts` — do not invent a new harness.

- [ ] **Step 2: Order SSE e2e** — create `services/order/src/__tests__/order-stream.e2e.test.ts`: place a real order via the app, open the stream, inject `INVENTORY_RESERVED` then `PAYMENT_SUCCEEDED` on Kafka (as `order-payment-leg.e2e.test.ts` does), and assert the stream shows `PENDING`/`AWAITING_PAYMENT` → `CONFIRMED`. Reuse the `order-payment-leg.e2e.test.ts` harness (createKafka/producer/consumer/rabbit/relay) and the `streamFrames` helper from Task 7's int test (copy it in).

```ts
it("streams PENDING/AWAITING_PAYMENT -> CONFIRMED for a real placed order", async () => {
  const id = await place(500); // same place() helper as order-payment-leg.e2e.test.ts
  const framesP = streamFrames(`/orders/${id}/stream`, (s) => s === "CONFIRMED", 25000);
  await new Promise((r) => setTimeout(r, 300));
  await producer.publish("inventory.events", reserved(id));
  await producer.publish("payment.events", makeEnvelope({
    type: PAYMENT_SUCCEEDED, version: 1, traceId: "t", producer: "payment",
    payload: { orderId: id, paymentId: "pay_1", amount: 500 },
  }));
  const statuses = (await framesP).map((f) => f.status);
  expect(statuses).toContain("AWAITING_PAYMENT");
  expect(statuses).toContain("CONFIRMED");
}, 40000);
```

- [ ] **Step 3: Run both e2e.**

Run: `pnpm vitest run services/payment/src/__tests__/webhook-refund.e2e.test.ts services/order/src/__tests__/order-stream.e2e.test.ts`
Expected: PASS.

- [ ] **Step 4: Manual demo runbook** — create `docs/runbooks/phase-3c-sse-webhook-refund-demo.md`:

```md
# Phase 3c — manual demo (SSE + async webhook + refund)

Prereq: `cp docker-compose.example.yml docker-compose.yml`, per-service `.env`s, images built.

1. `docker compose --profile app up -d`
2. Seed price + stock + cart, place an order whose total ends in **99** (async path):
   - `curl -X POST localhost:3002/admin/catalog -d '{"productId":"p1","name":"Widget","price":599}' -H 'content-type: application/json'`
   - `curl -X POST localhost:3001/inventory/stock -d '{"productId":"p1","quantity":10}' -H 'content-type: application/json'`
   - `curl -X POST localhost:3002/cart/items -H 'x-user-id: u1' -d '{"productId":"p1","quantity":1}' -H 'content-type: application/json'`
   - `ORDER=$(curl -sX POST localhost:3002/orders -H 'x-user-id: u1' | jq -r .orderId)`
3. Watch the live stream: `curl -N localhost:3002/orders/$ORDER/stream`
   → `PENDING` → `AWAITING_PAYMENT` … then it **waits** (Payment is PROCESSING, no event).
4. Resolve the async payment: `curl -X POST localhost:3003/webhooks/payment -d "{\"orderId\":\"$ORDER\",\"outcome\":\"SUCCEEDED\"}" -H 'content-type: application/json'`
   → the stream emits **CONFIRMED** and closes; reservation is CONSUMED.
5. Refund: `curl -X POST localhost:3003/admin/payments/$ORDER/refund`
   → Payment `REFUNDED`; `payment.refunded` emitted (no consumer this slice).
6. Compensation variant: an order ending in **01** with `outcome:"FAILED"` (or a sync %100==1) → `CANCELLED`, stock released.
7. `docker compose --profile app down`.

Order-side auto-cancel on a never-arriving webhook is Phase 7.
```

- [ ] **Step 5: Regression gate + format + typecheck (CI parity).**

Run: `pnpm vitest run services/order services/payment services/inventory packages/shared`
Expected: green (Order stream + transition/consumer; Payment charge/webhook/refund; Inventory unchanged; shared unchanged). Note: the pre-existing `sweeper.int.test.ts` stale-dev-DB caveat from 3b may show 2 failures locally — confirm they are the same non-regression (sweeper untouched) and green on fresh infra.
Run: `pnpm format` then `pnpm format:check`; `pnpm -r typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add services/payment/src/__tests__/webhook-refund.e2e.test.ts services/order/src/__tests__/order-stream.e2e.test.ts docs/runbooks/phase-3c-sse-webhook-refund-demo.md
git commit -m "test(3c): per-leg e2e (async webhook + SSE) + manual demo runbook"
# if format changed files:
git add -u && git commit -m "style: prettier"
```

---

## Self-Review

**Spec coverage:**
- SSE stream (`LISTEN/NOTIFY`, registry fan-out, endpoint, wiring, fail-fast) → Tasks 5 (NOTIFY) + 6 (registry/listener) + 7 (endpoint/main). Async webhook/timeout (`PROCESSING` + finalize CAS) → Tasks 2 + 3. Refund stub (CAS) → Task 4. `PAYMENT_REFUNDED` → Task 1. Schema comments/migration → Task 2. Per-leg e2e + runbook + regression gate → Task 8.
- Global constraints: CAS on webhook+refund (Tasks 3/4 `casStatus`); NOTIFY bound-param in-tx (Task 5); fail-fast listener (Task 6); terminal = CONFIRMED/CANCELLED (Task 6 `TERMINAL`); ids-only logging (all routes); migrations-CLI-only (Task 2); per-leg e2e + raw-http SSE test (Tasks 7/8).

**Placeholder scan:** none — every step has code/commands/expected output. Task 8's e2e reuse the *named existing* harnesses (`payment.e2e.test.ts`, `order-payment-leg.e2e.test.ts`) with the concrete added cases + the `streamFrames`/`waitFor` helpers shown; the "reuse the harness" instruction points at a specific file, not a placeholder.

**Type consistency:** `TransitionTx.notify` (Task 5) implemented by `transitionTx` (Task 5) + faked in the unit test; `ResolveTx`/`finalizePayment`/`refundPayment` (Task 3) consumed by both Payment routes (Tasks 3/4) and `resolveTx` (Task 3); `SubscriberRegistry`/`Sink`/`createOrderListener` (Task 6) consumed by `createApp` (Task 7) + `main.ts` (Task 7) + both SSE tests; `PAYMENT_REFUNDED` (Task 1) used by `refundPayment` (Task 3). `createApp` dep is optional → existing `createApp()` callers stay green (Task 7 Step 5 verifies).

**Infra:** Tasks 1/2/5/6 are unit/offline; Tasks 3/4/7/8 need Postgres (+ Kafka + Rabbit for Task 8 e2e). CI's integration job already has them.
