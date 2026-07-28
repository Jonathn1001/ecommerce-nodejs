# Phase 1 — Inventory Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `Inventory` service — an independently demoable saga leaf that reserves stock on `OrderPlaced`, releases it on `OrderCancelled` or expiry, and emits the results to Kafka via a transactional outbox.

**Architecture:** A pnpm/TypeScript service under `services/inventory`, mirroring the `services/hello` reference. An HTTP admin surface seeds/queries stock; a Kafka consumer on `order.events` drives reservations. Reserve is all-or-nothing across line items in one Postgres transaction: a conditional `UPDATE ... WHERE available >= qty` is the correctness guard, a Redis per-product lock wraps it as the taught distributed-lock pattern, and a `ProcessedEvent` insert in the same transaction gives exactly-once processing. A background sweeper releases expired reservations.

**Tech Stack:** TypeScript (CommonJS), Express, Prisma (PostgreSQL), KafkaJS, node-redis v4, zod, vitest + supertest, `@ecom/shared`, `@ecom/contracts`. Node 22, pnpm 10.

## Global Constraints

- **Language/module:** TypeScript, `module: commonjs`, `strict: true`. Node `>=22`. Every package extends `tsconfig.base.json`.
- **Package manager:** pnpm workspaces only. Cross-package deps use `workspace:*`.
- **DB-per-service:** Inventory owns the `inventory` Postgres database (already created by `infra/postgres/init/01-databases.sql`). It NEVER reads another service's database — no product FK, no cross-service lookup.
- **No PII in logs:** log ids/codes only — never request bodies, `password`, tokens, or email+name pairs. `console.*`/`logger.*` alike. (Enforced by `.claude/hooks/sensitive-logging-guard.sh`.)
- **Contracts are the source of truth:** every event's shape lives in `packages/contracts`; producer and consumer import it, never redefine it.
- **Prisma migrations via CLI only:** `pnpm --filter @ecom/inventory exec prisma migrate dev --name <change>`; never hand-edit files under `prisma/migrations/` (enforced by `.claude/hooks/prisma-migration-guard.sh`). **Consequence:** partial-unique indexes, `CHECK` constraints, and savepoints — none expressible in the Prisma schema DSL, and unaddable without editing a migration — are intentionally omitted; their guarantees are met in code (see the notes in Tasks 2 and 6).
- **Infra secrecy:** commit only `docker-compose.example.yml` and `.env.example`; the real `docker-compose.yml` and `.env` stay gitignored.
- **Commits:** stage specific files (never `git add -A`). Branch is `feat/microservices-streaming-rebuild`.
- **Prerequisite for integration/e2e steps:** the local stack must be up and this service migrated — `cp docker-compose.example.yml docker-compose.yml && cp .env.example .env && docker compose up -d`, then `cp services/inventory/.env.example services/inventory/.env` and run the migrate step from Task 2.

## File structure

**Modified — `packages/contracts` (Task 1):**
- `src/events/order.ts` — `OrderPlaced` / `OrderCancelled` payloads + constants (owned long-term by Order; defined here because Inventory needs them now).
- `src/events/inventory.ts` — `InventoryReserved` / `InventoryReservationFailed` / `InventoryReleased` payloads + constants.
- `src/index.ts` — re-export both.

**Created — `services/inventory` (Tasks 2–9):**
- `package.json`, `tsconfig.json`, `.env.example`, `Dockerfile`, `.dockerignore`
- `prisma/schema.prisma` — `Inventory`, `Reservation`, `Outbox`, `ProcessedEvent`
- `src/config.ts` — zod config (fail-fast)
- `src/db.ts` — Prisma client + per-service `.env` load
- `src/reserve.ts` — `ReserveTx` port + `reserveOrder` (pure domain core)
- `src/release.ts` — `ReleaseTx` port + `releaseForCancel` / `releaseRows` (pure domain core)
- `src/tx-adapters.ts` — Prisma-backed `ReserveTx` / `ReleaseTx` builders
- `src/outbox-adapter.ts` — `OutboxPort` over Prisma (for the shared relay)
- `src/app.ts` — Express: `POST /inventory/stock`, `GET /inventory/:productId`, health router
- `src/consumer.ts` — `handleOrderEvent` (branch + lock + transaction)
- `src/sweeper.ts` — `startExpirySweeper` / `sweepOnce`
- `src/main.ts` — wire producer + relay + consumer + sweeper + app + graceful shutdown
- `src/__tests__/reserve.unit.test.ts`, `release.unit.test.ts`, `inventory.int.test.ts`, `sweeper.int.test.ts`, `inventory.e2e.test.ts`

**Modified — infra (Task 9):**
- `docker-compose.example.yml` — add the `inventory` service block (profile `app`).

---

### Task 1: `packages/contracts` — order + inventory event contracts

**Files:**
- Create: `packages/contracts/src/events/order.ts`, `packages/contracts/src/events/inventory.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/__tests__/inventory-events.test.ts`

**Interfaces:**
- Produces:
  - `ORDER_PLACED = "order.placed"`, `ORDER_CANCELLED = "order.cancelled"`; `OrderLineSchema`/`OrderLine` (`{ productId: string; quantity: number }`, positive int qty); `OrderPlacedPayloadSchema`/`OrderPlacedPayload` (`{ orderId: string; items: OrderLine[] }`, non-empty); `OrderCancelledPayloadSchema`/`OrderCancelledPayload` (`{ orderId: string }`).
  - `INVENTORY_RESERVED = "inventory.reserved"`, `INVENTORY_RESERVATION_FAILED = "inventory.reservation_failed"`, `INVENTORY_RELEASED = "inventory.released"`; `InventoryReservedPayload`/`InventoryReleasedPayload` (`{ orderId; items: OrderLine[] }`), `InventoryReservationFailedPayload` (`{ orderId; reason: string }`) + their schemas.

- [ ] **Step 1: Write the failing test** — `packages/contracts/src/__tests__/inventory-events.test.ts`

```ts
import { describe, it, expect } from "vitest";
import {
  OrderPlacedPayloadSchema,
  OrderCancelledPayloadSchema,
  ORDER_PLACED,
  ORDER_CANCELLED,
  InventoryReservedPayloadSchema,
  InventoryReservationFailedPayloadSchema,
  INVENTORY_RESERVED,
  INVENTORY_RESERVATION_FAILED,
  INVENTORY_RELEASED,
} from "../index";

describe("order + inventory event contracts", () => {
  it("OrderPlaced requires a non-empty item list with positive int quantities", () => {
    expect(() => OrderPlacedPayloadSchema.parse({ orderId: "o1", items: [] })).toThrow();
    expect(() =>
      OrderPlacedPayloadSchema.parse({ orderId: "o1", items: [{ productId: "p1", quantity: 0 }] })
    ).toThrow();
    const ok = OrderPlacedPayloadSchema.parse({
      orderId: "o1",
      items: [{ productId: "p1", quantity: 2 }],
    });
    expect(ok.items[0].quantity).toBe(2);
  });

  it("OrderCancelled requires an orderId", () => {
    expect(() => OrderCancelledPayloadSchema.parse({})).toThrow();
    expect(OrderCancelledPayloadSchema.parse({ orderId: "o1" }).orderId).toBe("o1");
  });

  it("InventoryReservationFailed requires a reason", () => {
    expect(() => InventoryReservationFailedPayloadSchema.parse({ orderId: "o1" })).toThrow();
    const p = InventoryReservationFailedPayloadSchema.parse({ orderId: "o1", reason: "INSUFFICIENT_STOCK" });
    expect(p.reason).toBe("INSUFFICIENT_STOCK");
  });

  it("InventoryReserved echoes orderId + items", () => {
    const p = InventoryReservedPayloadSchema.parse({ orderId: "o1", items: [{ productId: "p1", quantity: 1 }] });
    expect(p.orderId).toBe("o1");
    expect(p.items).toHaveLength(1);
  });

  it("event constants carry stable wire values", () => {
    expect(ORDER_PLACED).toBe("order.placed");
    expect(ORDER_CANCELLED).toBe("order.cancelled");
    expect(INVENTORY_RESERVED).toBe("inventory.reserved");
    expect(INVENTORY_RESERVATION_FAILED).toBe("inventory.reservation_failed");
    expect(INVENTORY_RELEASED).toBe("inventory.released");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/contracts/src/__tests__/inventory-events.test.ts`
Expected: FAIL — cannot resolve the new exports from `../index`.

- [ ] **Step 3: Write `packages/contracts/src/events/order.ts`**

```ts
import { z } from "zod";

export const ORDER_PLACED = "order.placed" as const;
export const ORDER_CANCELLED = "order.cancelled" as const;

export const OrderLineSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().positive(),
});
export type OrderLine = z.infer<typeof OrderLineSchema>;

export const OrderPlacedPayloadSchema = z.object({
  orderId: z.string().min(1),
  items: z.array(OrderLineSchema).min(1),
});
export type OrderPlacedPayload = z.infer<typeof OrderPlacedPayloadSchema>;

export const OrderCancelledPayloadSchema = z.object({
  orderId: z.string().min(1),
});
export type OrderCancelledPayload = z.infer<typeof OrderCancelledPayloadSchema>;
```

- [ ] **Step 4: Write `packages/contracts/src/events/inventory.ts`**

```ts
import { z } from "zod";
import { OrderLineSchema } from "./order";

export const INVENTORY_RESERVED = "inventory.reserved" as const;
export const INVENTORY_RESERVATION_FAILED = "inventory.reservation_failed" as const;
export const INVENTORY_RELEASED = "inventory.released" as const;

export const InventoryReservedPayloadSchema = z.object({
  orderId: z.string().min(1),
  items: z.array(OrderLineSchema).min(1),
});
export type InventoryReservedPayload = z.infer<typeof InventoryReservedPayloadSchema>;

export const InventoryReservationFailedPayloadSchema = z.object({
  orderId: z.string().min(1),
  reason: z.string().min(1),
});
export type InventoryReservationFailedPayload = z.infer<typeof InventoryReservationFailedPayloadSchema>;

export const InventoryReleasedPayloadSchema = z.object({
  orderId: z.string().min(1),
  items: z.array(OrderLineSchema).min(1),
});
export type InventoryReleasedPayload = z.infer<typeof InventoryReleasedPayloadSchema>;
```

- [ ] **Step 5: Update `packages/contracts/src/index.ts`** — append the two new modules

```ts
export * from "./envelope";
export * from "./events/hello";
export * from "./events/order";
export * from "./events/inventory";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run packages/contracts/src/__tests__/inventory-events.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Typecheck contracts**

Run: `pnpm --filter @ecom/contracts typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src
git commit -m "feat(contracts): order + inventory saga events"
```

---

### Task 2: `services/inventory` — scaffold, schema, migration

**Files:**
- Create: `services/inventory/package.json`, `services/inventory/tsconfig.json`, `services/inventory/.env.example`, `services/inventory/prisma/schema.prisma`, `services/inventory/src/config.ts`, `services/inventory/src/db.ts`
- Generated by CLI: `services/inventory/prisma/migrations/**`

**Interfaces:**
- Produces: the `@ecom/inventory` workspace package; `config` (typed env); `prisma` (Prisma client bound to the `inventory` DB); tables `Inventory`, `Reservation`, `Outbox`, `ProcessedEvent`.

**Notes on omitted DB constraints (Global Constraints consequence):**
- `Inventory.available >= 0` is guaranteed by the reserve guard `WHERE available >= qty` (Task 6), not a DB `CHECK` (not expressible in Prisma DSL without editing a migration).
- Double-reserve of the same `OrderPlaced` is prevented by the `ProcessedEvent` PK dedup (Task 6), not a partial-unique index.

- [ ] **Step 1: Create `services/inventory/package.json`**

```json
{
  "name": "@ecom/inventory",
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

- [ ] **Step 2: Create `services/inventory/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `services/inventory/.env.example`**

```bash
DATABASE_URL=postgresql://ecom:ecom@localhost:5432/inventory
KAFKA_BROKERS=localhost:9092
REDIS_URL=redis://localhost:6379
RESERVATION_TTL_MS=900000
SWEEP_INTERVAL_MS=5000
PORT=3001
```

- [ ] **Step 4: Create `services/inventory/prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// Single sellable pool: `available` is the sellable count. Reserve decrements it
// (guarded by WHERE available >= qty), release increments it. No shopId, no
// product FK — Inventory trusts the incoming productId (DB-per-service).
model Inventory {
  productId String   @id
  available Int
  location  String   @default("Main Store")
  updatedAt DateTime @updatedAt
}

model Reservation {
  id         String    @id @default(uuid())
  orderId    String
  productId  String
  quantity   Int
  status     String    @default("ACTIVE") // ACTIVE | RELEASED
  expiresAt  DateTime
  createdAt  DateTime  @default(now())
  releasedAt DateTime?

  @@index([orderId])
  @@index([status, expiresAt]) // sweeper scan
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

model ProcessedEvent {
  eventId     String   @id
  type        String
  processedAt DateTime @default(now())
}
```

- [ ] **Step 5: Create `services/inventory/src/db.ts`**

```ts
import { config } from "dotenv";
import path from "path";
import { PrismaClient } from "@prisma/client";

// Load THIS service's .env whether started from repo root (vitest) or the
// service dir (tsx). Runs before `new PrismaClient()` reads DATABASE_URL.
config({ path: path.resolve(__dirname, "../.env") });

export const prisma = new PrismaClient();
```

- [ ] **Step 6: Create `services/inventory/src/config.ts`**

```ts
import { z } from "zod";
import { loadConfig } from "@ecom/shared";

export const config = loadConfig(
  z.object({
    DATABASE_URL: z.string().url(),
    KAFKA_BROKERS: z.string().default("localhost:9092"),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    RESERVATION_TTL_MS: z.coerce.number().int().positive().default(900_000),
    SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
    PORT: z.coerce.number().int().positive().default(3001),
  })
);
```

- [ ] **Step 7: Install and generate the Prisma client**

Run: `pnpm install`
Expected: resolves `@ecom/inventory` into the workspace with no error.

Run: `cp services/inventory/.env.example services/inventory/.env`
Expected: the service's local `.env` exists (gitignored).

Run: `pnpm --filter @ecom/inventory exec prisma generate`
Expected: "Generated Prisma Client".

- [ ] **Step 8: Create the initial migration** (stack must be up — see Global Constraints prerequisite)

Run: `pnpm --filter @ecom/inventory exec prisma migrate dev --name init`
Expected: creates `services/inventory/prisma/migrations/<ts>_init/` and applies it; the `inventory` DB now has the four tables. Leave the generated migration folder untouched.

- [ ] **Step 9: Typecheck**

Run: `pnpm --filter @ecom/inventory typecheck`
Expected: no errors.

- [ ] **Step 10: Commit** (the generated migration folder IS committed — it was produced by the CLI, not hand-edited)

```bash
git add services/inventory/package.json services/inventory/tsconfig.json \
  services/inventory/.env.example services/inventory/prisma services/inventory/src pnpm-lock.yaml
git status   # confirm services/inventory/.env is NOT staged
git commit -m "feat(inventory): service scaffold, prisma schema + init migration"
```

---

### Task 3: `src/reserve.ts` — reserve domain core (pure, unit-tested)

**Files:**
- Create: `services/inventory/src/reserve.ts`
- Test: `services/inventory/src/__tests__/reserve.unit.test.ts`

**Interfaces:**
- Consumes: `ORDER_PLACED`, `INVENTORY_RESERVED`, `INVENTORY_RESERVATION_FAILED` from `@ecom/contracts`.
- Produces:
  - `ReserveItem = { productId: string; quantity: number }`.
  - `ReserveTx` port: `markProcessed(eventId, type): Promise<boolean>` (false = duplicate), `tryDecrement(productId, qty): Promise<boolean>` (false = insufficient), `increment(productId, qty): Promise<void>`, `createReservation(orderId, item, expiresAt): Promise<void>`, `enqueue(type, orderId, payload): Promise<void>`.
  - `reserveOrder(tx: ReserveTx, p: { eventId; orderId; items: ReserveItem[]; expiresAt: Date }): Promise<"DUPLICATE" | "RESERVED" | "FAILED">`.

**Design note:** `reserveOrder` performs no locking and holds no Prisma reference — locks and the real transaction are the consumer's job (Task 6). The failure branch's `increment` loop realizes the spec's SAVEPOINT-rollback as in-transaction compensating increments (Prisma has no savepoint API); because Task 6 runs the whole function inside one `prisma.$transaction`, the net effect on a shortfall is zero stock change plus a recorded `ProcessedEvent` and a `Failed` outbox row.

- [ ] **Step 1: Write the failing test** — `services/inventory/src/__tests__/reserve.unit.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { reserveOrder, type ReserveTx, type ReserveItem } from "../reserve";
import { INVENTORY_RESERVED, INVENTORY_RESERVATION_FAILED } from "@ecom/contracts";

function fakeTx(stock: Record<string, number>) {
  const processed = new Set<string>();
  const reservations: Array<{ orderId: string; item: ReserveItem }> = [];
  const emitted: Array<{ type: string; orderId: string; payload: unknown }> = [];
  const tx: ReserveTx = {
    async markProcessed(eventId) {
      if (processed.has(eventId)) return false;
      processed.add(eventId);
      return true;
    },
    async tryDecrement(productId, qty) {
      if ((stock[productId] ?? 0) < qty) return false;
      stock[productId] -= qty;
      return true;
    },
    async increment(productId, qty) {
      stock[productId] = (stock[productId] ?? 0) + qty;
    },
    async createReservation(orderId, item) {
      reservations.push({ orderId, item });
    },
    async enqueue(type, orderId, payload) {
      emitted.push({ type, orderId, payload });
    },
  };
  return { tx, stock, reservations, emitted };
}

const at = new Date("2026-07-21T00:00:00.000Z");

describe("reserveOrder", () => {
  it("reserves every item, decrements stock, emits InventoryReserved", async () => {
    const f = fakeTx({ p1: 5, p2: 3 });
    const outcome = await reserveOrder(f.tx, {
      eventId: "e1",
      orderId: "o1",
      items: [{ productId: "p2", quantity: 1 }, { productId: "p1", quantity: 2 }],
      expiresAt: at,
    });
    expect(outcome).toBe("RESERVED");
    expect(f.stock).toEqual({ p1: 3, p2: 2 });
    expect(f.reservations).toHaveLength(2);
    expect(f.emitted).toEqual([
      { type: INVENTORY_RESERVED, orderId: "o1", payload: { orderId: "o1", items: [{ productId: "p1", quantity: 2 }, { productId: "p2", quantity: 1 }] } },
    ]);
  });

  it("is all-or-nothing: a shortfall on any line restores every decrement and emits Failed", async () => {
    const f = fakeTx({ p1: 5, p2: 0 });
    const outcome = await reserveOrder(f.tx, {
      eventId: "e2",
      orderId: "o2",
      items: [{ productId: "p1", quantity: 2 }, { productId: "p2", quantity: 1 }],
      expiresAt: at,
    });
    expect(outcome).toBe("FAILED");
    expect(f.stock).toEqual({ p1: 5, p2: 0 }); // p1's decrement was rolled back
    expect(f.reservations).toHaveLength(0);
    expect(f.emitted).toEqual([
      { type: INVENTORY_RESERVATION_FAILED, orderId: "o2", payload: { orderId: "o2", reason: "INSUFFICIENT_STOCK" } },
    ]);
  });

  it("skips a duplicate event with no side effects", async () => {
    const f = fakeTx({ p1: 5 });
    await reserveOrder(f.tx, { eventId: "e3", orderId: "o3", items: [{ productId: "p1", quantity: 1 }], expiresAt: at });
    const outcome = await reserveOrder(f.tx, { eventId: "e3", orderId: "o3", items: [{ productId: "p1", quantity: 1 }], expiresAt: at });
    expect(outcome).toBe("DUPLICATE");
    expect(f.stock).toEqual({ p1: 4 }); // decremented once, not twice
    expect(f.reservations).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run services/inventory/src/__tests__/reserve.unit.test.ts`
Expected: FAIL — cannot resolve `../reserve`.

- [ ] **Step 3: Write `services/inventory/src/reserve.ts`**

```ts
import {
  ORDER_PLACED,
  INVENTORY_RESERVED,
  INVENTORY_RESERVATION_FAILED,
} from "@ecom/contracts";

export type ReserveItem = { productId: string; quantity: number };

export interface ReserveTx {
  markProcessed(eventId: string, type: string): Promise<boolean>; // false => already processed
  tryDecrement(productId: string, qty: number): Promise<boolean>; // false => insufficient stock
  increment(productId: string, qty: number): Promise<void>; // compensating undo
  createReservation(orderId: string, item: ReserveItem, expiresAt: Date): Promise<void>;
  enqueue(type: string, orderId: string, payload: unknown): Promise<void>;
}

function byProductId(a: ReserveItem, b: ReserveItem): number {
  return a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0;
}

export async function reserveOrder(
  tx: ReserveTx,
  p: { eventId: string; orderId: string; items: ReserveItem[]; expiresAt: Date }
): Promise<"DUPLICATE" | "RESERVED" | "FAILED"> {
  const fresh = await tx.markProcessed(p.eventId, ORDER_PLACED);
  if (!fresh) return "DUPLICATE";

  // Deterministic order so concurrent multi-item orders can never deadlock.
  const items = [...p.items].sort(byProductId);
  const applied: ReserveItem[] = [];

  for (const item of items) {
    const ok = await tx.tryDecrement(item.productId, item.quantity);
    if (!ok) {
      // Roll back the decrements already applied in this transaction, keep the
      // ProcessedEvent row, and emit the business failure (never thrown).
      for (const done of applied) await tx.increment(done.productId, done.quantity);
      await tx.enqueue(INVENTORY_RESERVATION_FAILED, p.orderId, {
        orderId: p.orderId,
        reason: "INSUFFICIENT_STOCK",
      });
      return "FAILED";
    }
    applied.push(item);
  }

  for (const item of items) await tx.createReservation(p.orderId, item, p.expiresAt);
  await tx.enqueue(INVENTORY_RESERVED, p.orderId, { orderId: p.orderId, items });
  return "RESERVED";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run services/inventory/src/__tests__/reserve.unit.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add services/inventory/src/reserve.ts services/inventory/src/__tests__/reserve.unit.test.ts
git commit -m "feat(inventory): reserve domain core (all-or-nothing, unit-tested)"
```

---

### Task 4: `src/release.ts` — release domain core (pure, unit-tested)

**Files:**
- Create: `services/inventory/src/release.ts`
- Test: `services/inventory/src/__tests__/release.unit.test.ts`

**Interfaces:**
- Consumes: `ORDER_CANCELLED`, `INVENTORY_RELEASED` from `@ecom/contracts`.
- Produces:
  - `ReleasableRow = { id: string; productId: string; quantity: number }`.
  - `ReleaseCoreTx` port: `increment(productId, qty): Promise<void>`, `markReleased(reservationId): Promise<void>`, `enqueue(type, orderId, payload): Promise<void>`.
  - `ReleaseTx` port: `ReleaseCoreTx` plus `markProcessed(eventId, type): Promise<boolean>` and `activeByOrder(orderId): Promise<ReleasableRow[]>`.
  - `releaseRows(tx: ReleaseCoreTx, orderId, rows: ReleasableRow[]): Promise<"RELEASED" | "NOOP">` (used by cancel and sweeper).
  - `releaseForCancel(tx: ReleaseTx, p: { eventId; orderId }): Promise<"DUPLICATE" | "RELEASED" | "NOOP">`.

- [ ] **Step 1: Write the failing test** — `services/inventory/src/__tests__/release.unit.test.ts`

```ts
import { describe, it, expect } from "vitest";
import {
  releaseRows,
  releaseForCancel,
  type ReleaseTx,
  type ReleasableRow,
} from "../release";
import { INVENTORY_RELEASED } from "@ecom/contracts";

function fake(active: Record<string, ReleasableRow[]>, stock: Record<string, number>) {
  const processed = new Set<string>();
  const released = new Set<string>();
  const emitted: Array<{ type: string; orderId: string; payload: unknown }> = [];
  const tx: ReleaseTx = {
    async markProcessed(eventId) {
      if (processed.has(eventId)) return false;
      processed.add(eventId);
      return true;
    },
    async activeByOrder(orderId) {
      return (active[orderId] ?? []).filter((r) => !released.has(r.id));
    },
    async increment(productId, qty) {
      stock[productId] = (stock[productId] ?? 0) + qty;
    },
    async markReleased(id) {
      released.add(id);
    },
    async enqueue(type, orderId, payload) {
      emitted.push({ type, orderId, payload });
    },
  };
  return { tx, stock, released, emitted };
}

describe("release core", () => {
  it("releaseForCancel restores stock, marks reservations RELEASED, emits InventoryReleased", async () => {
    const f = fake({ o1: [{ id: "r1", productId: "p1", quantity: 2 }] }, { p1: 3 });
    const outcome = await releaseForCancel(f.tx, { eventId: "e1", orderId: "o1" });
    expect(outcome).toBe("RELEASED");
    expect(f.stock).toEqual({ p1: 5 });
    expect(f.released.has("r1")).toBe(true);
    expect(f.emitted).toEqual([
      { type: INVENTORY_RELEASED, orderId: "o1", payload: { orderId: "o1", items: [{ productId: "p1", quantity: 2 }] } },
    ]);
  });

  it("no-ops (no emit) when the order has no ACTIVE reservations", async () => {
    const f = fake({ o2: [] }, {});
    const outcome = await releaseForCancel(f.tx, { eventId: "e2", orderId: "o2" });
    expect(outcome).toBe("NOOP");
    expect(f.emitted).toHaveLength(0);
  });

  it("skips a duplicate cancel", async () => {
    const f = fake({ o3: [{ id: "r3", productId: "p1", quantity: 1 }] }, { p1: 0 });
    await releaseForCancel(f.tx, { eventId: "e3", orderId: "o3" });
    const outcome = await releaseForCancel(f.tx, { eventId: "e3", orderId: "o3" });
    expect(outcome).toBe("DUPLICATE");
    expect(f.stock).toEqual({ p1: 1 }); // released once, not twice
  });

  it("releaseRows returns NOOP and emits nothing for an empty set", async () => {
    const f = fake({}, {});
    const outcome = await releaseRows(f.tx, "o9", []);
    expect(outcome).toBe("NOOP");
    expect(f.emitted).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run services/inventory/src/__tests__/release.unit.test.ts`
Expected: FAIL — cannot resolve `../release`.

- [ ] **Step 3: Write `services/inventory/src/release.ts`**

```ts
import { ORDER_CANCELLED, INVENTORY_RELEASED } from "@ecom/contracts";

export type ReleasableRow = { id: string; productId: string; quantity: number };

export interface ReleaseCoreTx {
  increment(productId: string, qty: number): Promise<void>;
  markReleased(reservationId: string): Promise<void>;
  enqueue(type: string, orderId: string, payload: unknown): Promise<void>;
}

export interface ReleaseTx extends ReleaseCoreTx {
  markProcessed(eventId: string, type: string): Promise<boolean>;
  activeByOrder(orderId: string): Promise<ReleasableRow[]>;
}

// Shared primitive: give back stock and mark each row RELEASED. Emits exactly one
// InventoryReleased when something was released; NOOP (no emit) for an empty set.
export async function releaseRows(
  tx: ReleaseCoreTx,
  orderId: string,
  rows: ReleasableRow[]
): Promise<"RELEASED" | "NOOP"> {
  if (rows.length === 0) return "NOOP";
  for (const r of rows) {
    await tx.increment(r.productId, r.quantity);
    await tx.markReleased(r.id);
  }
  await tx.enqueue(INVENTORY_RELEASED, orderId, {
    orderId,
    items: rows.map((r) => ({ productId: r.productId, quantity: r.quantity })),
  });
  return "RELEASED";
}

export async function releaseForCancel(
  tx: ReleaseTx,
  p: { eventId: string; orderId: string }
): Promise<"DUPLICATE" | "RELEASED" | "NOOP"> {
  const fresh = await tx.markProcessed(p.eventId, ORDER_CANCELLED);
  if (!fresh) return "DUPLICATE";
  const rows = await tx.activeByOrder(p.orderId);
  return releaseRows(tx, p.orderId, rows);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run services/inventory/src/__tests__/release.unit.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add services/inventory/src/release.ts services/inventory/src/__tests__/release.unit.test.ts
git commit -m "feat(inventory): release domain core (cancel + sweeper primitive, unit-tested)"
```

---

### Task 5: `src/app.ts` — HTTP admin surface + health

**Files:**
- Create: `services/inventory/src/app.ts`
- Test: `services/inventory/src/__tests__/app.int.test.ts` (integration — needs the stack up + migrated)

**Interfaces:**
- Consumes: `traceMiddleware`, `createLogger`, `createHealthRouter`, `getRedis` from `@ecom/shared`; `prisma` from `./db`.
- Produces: `createApp(): express.Application` with `POST /inventory/stock` (upsert add stock — returns `{ productId, available }`), `GET /inventory/:productId` (`{ productId, available, activeReservations }`, 404 when unknown), and `/healthz`+`/readyz`.

- [ ] **Step 1: Write the failing test** — `services/inventory/src/__tests__/app.int.test.ts`

```ts
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { prisma } from "../db";
import { getRedis } from "@ecom/shared";

const app = createApp();

describe("inventory HTTP admin (integration — needs docker compose up + migrated)", () => {
  afterAll(async () => {
    (await getRedis()).quit();
    await prisma.$disconnect();
  });

  it("POST /inventory/stock seeds then increments the same product", async () => {
    const productId = `p_${randomUUID()}`;
    const seed = await request(app).post("/inventory/stock").send({ productId, quantity: 5 });
    expect(seed.status).toBe(201);
    expect(seed.body).toEqual({ productId, available: 5 });

    const add = await request(app).post("/inventory/stock").send({ productId, quantity: 3 });
    expect(add.body.available).toBe(8);
  });

  it("POST /inventory/stock rejects a non-positive quantity", async () => {
    const res = await request(app).post("/inventory/stock").send({ productId: "x", quantity: 0 });
    expect(res.status).toBe(400);
  });

  it("GET /inventory/:productId returns level + active reservation count, 404 when unknown", async () => {
    const productId = `p_${randomUUID()}`;
    await request(app).post("/inventory/stock").send({ productId, quantity: 4 });
    const res = await request(app).get(`/inventory/${productId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ productId, available: 4, activeReservations: 0 });

    const missing = await request(app).get(`/inventory/p_${randomUUID()}`);
    expect(missing.status).toBe(404);
  });

  it("GET /readyz reports healthy", async () => {
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run services/inventory/src/__tests__/app.int.test.ts`
Expected: FAIL — cannot resolve `../app`.

- [ ] **Step 3: Write `services/inventory/src/app.ts`**

```ts
import express from "express";
import { z } from "zod";
import {
  traceMiddleware,
  createLogger,
  createHealthRouter,
  getRedis,
} from "@ecom/shared";
import { prisma } from "./db";

const log = createLogger("inventory");

const AddStockSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().positive(),
  location: z.string().min(1).optional(),
});

export function createApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(traceMiddleware());

  app.use(
    createHealthRouter({
      db: async () => void (await prisma.$queryRaw`SELECT 1`),
      redis: async () => void (await (await getRedis()).ping()),
    })
  );

  // Add/seed stock: upsert the sellable pool. New product => create; existing =>
  // increment. Product validity is Catalog's concern — Inventory trusts productId.
  app.post("/inventory/stock", async (req, res) => {
    const parsed = AddStockSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid stock request" });
    const { productId, quantity, location } = parsed.data;
    try {
      const row = await prisma.inventory.upsert({
        where: { productId },
        create: { productId, available: quantity, ...(location ? { location } : {}) },
        update: { available: { increment: quantity }, ...(location ? { location } : {}) },
      });
      log.info("stock_added", { productId, traceId: req.traceId });
      res.status(201).json({ productId, available: row.available });
    } catch {
      // Never log the caught error or request body — ids/codes only.
      log.error("stock_add_failed", { productId, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  app.get("/inventory/:productId", async (req, res) => {
    const { productId } = req.params;
    try {
      const row = await prisma.inventory.findUnique({ where: { productId } });
      if (!row) return res.status(404).json({ error: "not found" });
      const activeReservations = await prisma.reservation.count({
        where: { productId, status: "ACTIVE" },
      });
      res.json({ productId, available: row.available, activeReservations });
    } catch {
      log.error("stock_query_failed", { productId, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run services/inventory/src/__tests__/app.int.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add services/inventory/src/app.ts services/inventory/src/__tests__/app.int.test.ts
git commit -m "feat(inventory): HTTP admin surface (add/query stock) + health"
```

---

### Task 6: `src/tx-adapters.ts` + `src/outbox-adapter.ts` + `src/consumer.ts` — order-events consumer

**Files:**
- Create: `services/inventory/src/tx-adapters.ts`, `services/inventory/src/outbox-adapter.ts`, `services/inventory/src/consumer.ts`
- Test: `services/inventory/src/__tests__/inventory.int.test.ts` (integration — needs the stack up + migrated)

**Interfaces:**
- Consumes: `reserveOrder`/`ReserveTx` (Task 3), `releaseForCancel`/`ReleaseTx` (Task 4), `prisma` (Task 2), `config` (Task 2); `acquireLock`/`releaseLock`/`createLogger`/`OutboxPort`/`OutboxRow` from `@ecom/shared`; `ORDER_PLACED`/`ORDER_CANCELLED`/`OrderPlacedPayloadSchema`/`OrderCancelledPayloadSchema`/`EventEnvelope` from `@ecom/contracts`.
- Produces:
  - `reserveTx(tx, traceId): ReserveTx` and `releaseTx(tx, traceId): ReleaseTx` (Prisma-backed adapters).
  - `outboxPort: OutboxPort`.
  - `handleOrderEvent(env: EventEnvelope): Promise<void>` — the Kafka handler for `order.events`.

**Design notes:**
- `markProcessed` maps to `tx.processedEvent.createMany({ data: [...], skipDuplicates: true })` (`count > 0` ⇒ newly inserted) — this is the `INSERT ... ON CONFLICT DO NOTHING` from the spec, and it never throws on a duplicate, so the whole transaction commits as a clean no-op.
- `tryDecrement` maps to `tx.inventory.updateMany({ where: { productId, available: { gte: qty } }, data: { available: { decrement: qty } } })` — the atomic conditional-`UPDATE` correctness guard; `count === 0` ⇒ insufficient.
- The Redis per-product lock wraps the transaction in the consumer. It is the *taught* pattern — the SQL guard above is the real guarantee, so if a lock cannot be acquired the handler logs `lock_contention_degraded` and proceeds rather than dead-lettering a valid order.
- Insufficient stock returns normally (emits `InventoryReservationFailed`); only unexpected errors throw and reach the shared consumer's DLQ-parking.

- [ ] **Step 1: Write the failing test** — `services/inventory/src/__tests__/inventory.int.test.ts`

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { handleOrderEvent } from "../consumer";
import { prisma } from "../db";
import { getRedis } from "@ecom/shared";
import {
  makeEnvelope,
  ORDER_PLACED,
  ORDER_CANCELLED,
  INVENTORY_RESERVED,
  INVENTORY_RESERVATION_FAILED,
  INVENTORY_RELEASED,
} from "@ecom/contracts";

async function seed(productId: string, available: number) {
  await prisma.inventory.upsert({
    where: { productId },
    create: { productId, available },
    update: { available },
  });
}
async function availableOf(productId: string) {
  return (await prisma.inventory.findUnique({ where: { productId } }))?.available;
}
function placed(orderId: string, items: Array<{ productId: string; quantity: number }>) {
  return makeEnvelope({ type: ORDER_PLACED, version: 1, traceId: "t", producer: "test", payload: { orderId, items } });
}

describe("inventory consumer (integration — needs docker compose up + migrated)", () => {
  afterAll(async () => {
    (await getRedis()).quit();
    await prisma.$disconnect();
  });

  it("OrderPlaced reserves: decrements stock, writes an ACTIVE reservation + InventoryReserved outbox", async () => {
    const p1 = `p_${randomUUID()}`;
    const orderId = `o_${randomUUID()}`;
    await seed(p1, 5);
    await handleOrderEvent(placed(orderId, [{ productId: p1, quantity: 3 }]));

    expect(await availableOf(p1)).toBe(2);
    expect(await prisma.reservation.count({ where: { orderId, status: "ACTIVE" } })).toBe(1);
    expect(await prisma.outbox.count({ where: { aggregateId: orderId, type: INVENTORY_RESERVED } })).toBe(1);
  });

  it("insufficient stock emits InventoryReservationFailed and leaves stock untouched", async () => {
    const p1 = `p_${randomUUID()}`;
    const orderId = `o_${randomUUID()}`;
    await seed(p1, 1);
    await handleOrderEvent(placed(orderId, [{ productId: p1, quantity: 3 }]));

    expect(await availableOf(p1)).toBe(1);
    expect(await prisma.reservation.count({ where: { orderId } })).toBe(0);
    expect(await prisma.outbox.count({ where: { aggregateId: orderId, type: INVENTORY_RESERVATION_FAILED } })).toBe(1);
  });

  it("is all-or-nothing across items", async () => {
    const p1 = `p_${randomUUID()}`;
    const p2 = `p_${randomUUID()}`;
    const orderId = `o_${randomUUID()}`;
    await seed(p1, 5);
    await seed(p2, 0);
    await handleOrderEvent(placed(orderId, [{ productId: p1, quantity: 2 }, { productId: p2, quantity: 1 }]));

    expect(await availableOf(p1)).toBe(5); // p1 decrement rolled back
    expect(await prisma.outbox.count({ where: { aggregateId: orderId, type: INVENTORY_RESERVATION_FAILED } })).toBe(1);
  });

  it("OrderCancelled releases the reservation and restores stock", async () => {
    const p1 = `p_${randomUUID()}`;
    const orderId = `o_${randomUUID()}`;
    await seed(p1, 5);
    await handleOrderEvent(placed(orderId, [{ productId: p1, quantity: 2 }]));
    expect(await availableOf(p1)).toBe(3);

    await handleOrderEvent(
      makeEnvelope({ type: ORDER_CANCELLED, version: 1, traceId: "t", producer: "test", payload: { orderId } })
    );
    expect(await availableOf(p1)).toBe(5);
    expect(await prisma.reservation.count({ where: { orderId, status: "RELEASED" } })).toBe(1);
    expect(await prisma.outbox.count({ where: { aggregateId: orderId, type: INVENTORY_RELEASED } })).toBe(1);
  });

  it("dedupes a redelivered OrderPlaced (reserves once)", async () => {
    const p1 = `p_${randomUUID()}`;
    const orderId = `o_${randomUUID()}`;
    await seed(p1, 5);
    const env = placed(orderId, [{ productId: p1, quantity: 2 }]);
    await handleOrderEvent(env);
    await handleOrderEvent(env); // same eventId

    expect(await availableOf(p1)).toBe(3); // decremented once
    expect(await prisma.reservation.count({ where: { orderId } })).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run services/inventory/src/__tests__/inventory.int.test.ts`
Expected: FAIL — cannot resolve `../consumer`.

- [ ] **Step 3: Write `services/inventory/src/outbox-adapter.ts`**

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

- [ ] **Step 4: Write `services/inventory/src/tx-adapters.ts`**

```ts
import { Prisma } from "@prisma/client";
import type { ReserveTx } from "./reserve";
import type { ReleaseTx } from "./release";

// Bind a ReserveTx to one Prisma interactive-transaction client. traceId is
// closured so the domain core stays free of transport concerns.
export function reserveTx(tx: Prisma.TransactionClient, traceId: string): ReserveTx {
  return {
    async markProcessed(eventId, type) {
      const r = await tx.processedEvent.createMany({ data: [{ eventId, type }], skipDuplicates: true });
      return r.count > 0;
    },
    async tryDecrement(productId, qty) {
      const r = await tx.inventory.updateMany({
        where: { productId, available: { gte: qty } },
        data: { available: { decrement: qty } },
      });
      return r.count > 0;
    },
    async increment(productId, qty) {
      await tx.inventory.update({ where: { productId }, data: { available: { increment: qty } } });
    },
    async createReservation(orderId, item, expiresAt) {
      await tx.reservation.create({
        data: { orderId, productId: item.productId, quantity: item.quantity, status: "ACTIVE", expiresAt },
      });
    },
    async enqueue(type, orderId, payload) {
      await tx.outbox.create({
        data: { aggregateType: "inventory", aggregateId: orderId, type, traceId, producer: "inventory", payload: payload as Prisma.InputJsonValue },
      });
    },
  };
}

export function releaseTx(tx: Prisma.TransactionClient, traceId: string): ReleaseTx {
  return {
    async markProcessed(eventId, type) {
      const r = await tx.processedEvent.createMany({ data: [{ eventId, type }], skipDuplicates: true });
      return r.count > 0;
    },
    async activeByOrder(orderId) {
      const rows = await tx.reservation.findMany({
        where: { orderId, status: "ACTIVE" },
        select: { id: true, productId: true, quantity: true },
      });
      return rows;
    },
    async increment(productId, qty) {
      await tx.inventory.update({ where: { productId }, data: { available: { increment: qty } } });
    },
    async markReleased(id) {
      await tx.reservation.update({ where: { id }, data: { status: "RELEASED", releasedAt: new Date() } });
    },
    async enqueue(type, orderId, payload) {
      await tx.outbox.create({
        data: { aggregateType: "inventory", aggregateId: orderId, type, traceId, producer: "inventory", payload: payload as Prisma.InputJsonValue },
      });
    },
  };
}
```

- [ ] **Step 5: Write `services/inventory/src/consumer.ts`**

```ts
import { acquireLock, releaseLock, createLogger, type Logger } from "@ecom/shared";
import {
  EventEnvelope,
  ORDER_PLACED,
  ORDER_CANCELLED,
  OrderPlacedPayloadSchema,
  OrderCancelledPayloadSchema,
} from "@ecom/contracts";
import { prisma } from "./db";
import { config } from "./config";
import { reserveOrder } from "./reserve";
import { releaseForCancel } from "./release";
import { reserveTx, releaseTx } from "./tx-adapters";

const log: Logger = createLogger("inventory-consumer");

export async function handleOrderEvent(env: EventEnvelope): Promise<void> {
  if (env.type === ORDER_PLACED) return handlePlaced(env);
  if (env.type === ORDER_CANCELLED) return handleCancelled(env);
  // Other event types on the topic are not ours — ignore (no-op, no DLQ).
}

async function handlePlaced(env: EventEnvelope): Promise<void> {
  const payload = OrderPlacedPayloadSchema.parse(env.payload);
  const products = [...new Set(payload.items.map((i) => i.productId))].sort();
  const held: Array<{ key: string; token: string }> = [];
  try {
    // Distributed-lock lesson: lock every product, in sorted order (deadlock-free).
    // The SQL guard is the real correctness boundary, so degrade rather than DLQ.
    for (const productId of products) {
      const handle = await acquireLock(productId);
      if (handle) held.push(handle);
      else log.warn("lock_contention_degraded", { productId, traceId: env.traceId });
    }

    const outcome = await prisma.$transaction((tx) =>
      reserveOrder(reserveTx(tx, env.traceId), {
        eventId: env.eventId,
        orderId: payload.orderId,
        items: payload.items,
        expiresAt: new Date(Date.now() + config.RESERVATION_TTL_MS),
      })
    );
    log.info("order_placed_handled", { orderId: payload.orderId, outcome, traceId: env.traceId });
  } finally {
    for (const handle of held) await releaseLock(handle);
  }
}

async function handleCancelled(env: EventEnvelope): Promise<void> {
  const payload = OrderCancelledPayloadSchema.parse(env.payload);
  const outcome = await prisma.$transaction((tx) =>
    releaseForCancel(releaseTx(tx, env.traceId), { eventId: env.eventId, orderId: payload.orderId })
  );
  log.info("order_cancelled_handled", { orderId: payload.orderId, outcome, traceId: env.traceId });
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run services/inventory/src/__tests__/inventory.int.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @ecom/inventory typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add services/inventory/src/outbox-adapter.ts services/inventory/src/tx-adapters.ts \
  services/inventory/src/consumer.ts services/inventory/src/__tests__/inventory.int.test.ts
git commit -m "feat(inventory): order.events consumer — reserve/release in one tx with locks"
```

---

### Task 7: `src/sweeper.ts` — reservation expiry sweeper

**Files:**
- Create: `services/inventory/src/sweeper.ts`
- Test: `services/inventory/src/__tests__/sweeper.int.test.ts` (integration — needs the stack up + migrated)

**Interfaces:**
- Consumes: `releaseRows`/`ReleaseCoreTx` (Task 4), `prisma` (Task 2); `createLogger` from `@ecom/shared`; `randomUUID` from `node:crypto`.
- Produces: `sweepOnce(): Promise<number>` (releases all expired ACTIVE reservations, returns the count released) and `startExpirySweeper(intervalMs): { stop: () => void }`.

**Design note:** the sweeper reuses `releaseRows` (the no-dedup primitive) inside one transaction per order. Overlapping ticks are guarded by a `running` flag; a reservation already flipped to `RELEASED` is not re-selected, so the sweep is idempotent.

- [ ] **Step 1: Write the failing test** — `services/inventory/src/__tests__/sweeper.int.test.ts`

```ts
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { sweepOnce } from "../sweeper";
import { prisma } from "../db";
import { getRedis } from "@ecom/shared";
import { INVENTORY_RELEASED } from "@ecom/contracts";

describe("expiry sweeper (integration — needs docker compose up + migrated)", () => {
  afterAll(async () => {
    (await getRedis()).quit();
    await prisma.$disconnect();
  });

  it("releases an expired ACTIVE reservation, restores stock, emits InventoryReleased", async () => {
    const productId = `p_${randomUUID()}`;
    const orderId = `o_${randomUUID()}`;
    // available=3 models 2 already held out of an original 5
    await prisma.inventory.create({ data: { productId, available: 3 } });
    await prisma.reservation.create({
      data: {
        orderId,
        productId,
        quantity: 2,
        status: "ACTIVE",
        expiresAt: new Date(Date.now() - 60_000), // already expired
      },
    });

    const released = await sweepOnce();
    expect(released).toBeGreaterThanOrEqual(1);

    expect((await prisma.inventory.findUnique({ where: { productId } }))?.available).toBe(5);
    expect(await prisma.reservation.count({ where: { orderId, status: "RELEASED" } })).toBe(1);
    expect(await prisma.outbox.count({ where: { aggregateId: orderId, type: INVENTORY_RELEASED } })).toBe(1);
  });

  it("leaves a not-yet-expired reservation alone", async () => {
    const productId = `p_${randomUUID()}`;
    const orderId = `o_${randomUUID()}`;
    await prisma.inventory.create({ data: { productId, available: 1 } });
    await prisma.reservation.create({
      data: { orderId, productId, quantity: 1, status: "ACTIVE", expiresAt: new Date(Date.now() + 3_600_000) },
    });

    await sweepOnce();
    expect(await prisma.reservation.count({ where: { orderId, status: "ACTIVE" } })).toBe(1);
    expect((await prisma.inventory.findUnique({ where: { productId } }))?.available).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run services/inventory/src/__tests__/sweeper.int.test.ts`
Expected: FAIL — cannot resolve `../sweeper`.

- [ ] **Step 3: Write `services/inventory/src/sweeper.ts`**

```ts
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { createLogger } from "@ecom/shared";
import { prisma } from "./db";
import { releaseRows, type ReleaseCoreTx } from "./release";

const log = createLogger("inventory-sweeper");

function sweepTx(tx: Prisma.TransactionClient, traceId: string): ReleaseCoreTx {
  return {
    async increment(productId, qty) {
      await tx.inventory.update({ where: { productId }, data: { available: { increment: qty } } });
    },
    async markReleased(id) {
      await tx.reservation.update({ where: { id }, data: { status: "RELEASED", releasedAt: new Date() } });
    },
    async enqueue(type, orderId, payload) {
      await tx.outbox.create({
        data: { aggregateType: "inventory", aggregateId: orderId, type, traceId, producer: "inventory", payload: payload as Prisma.InputJsonValue },
      });
    },
  };
}

export async function sweepOnce(): Promise<number> {
  const expired = await prisma.reservation.findMany({
    where: { status: "ACTIVE", expiresAt: { lt: new Date() } },
    select: { id: true, orderId: true, productId: true, quantity: true },
  });
  if (expired.length === 0) return 0;

  const byOrder = new Map<string, typeof expired>();
  for (const r of expired) {
    const list = byOrder.get(r.orderId) ?? [];
    list.push(r);
    byOrder.set(r.orderId, list);
  }

  let count = 0;
  for (const [orderId, rows] of byOrder) {
    const traceId = `sweeper-${randomUUID()}`;
    await prisma.$transaction((tx) =>
      releaseRows(
        sweepTx(tx, traceId),
        orderId,
        rows.map((r) => ({ id: r.id, productId: r.productId, quantity: r.quantity }))
      )
    );
    count += rows.length;
  }
  log.info("reservations_swept", { count });
  return count;
}

export function startExpirySweeper(intervalMs: number): { stop: () => void } {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sweepOnce();
    } catch (e) {
      log.error("sweep_failed", { message: (e as Error).message });
    } finally {
      running = false;
    }
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run services/inventory/src/__tests__/sweeper.int.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add services/inventory/src/sweeper.ts services/inventory/src/__tests__/sweeper.int.test.ts
git commit -m "feat(inventory): reservation expiry sweeper (auto-release)"
```

---

### Task 8: `src/main.ts` — wiring + graceful shutdown + slice e2e

**Files:**
- Create: `services/inventory/src/main.ts`
- Test: `services/inventory/src/__tests__/inventory.e2e.test.ts` (e2e — needs the stack up + migrated)

**Interfaces:**
- Consumes: `createApp` (Task 5), `outboxPort` (Task 6), `handleOrderEvent` (Task 6), `startExpirySweeper` (Task 7), `prisma` (Task 2), `config` (Task 2); `createKafka`/`createProducer`/`createConsumer`/`startOutboxRelay`/`createLogger`/`gracefulShutdown`/`getRedis` from `@ecom/shared`.
- Produces: the runnable service entrypoint. Consumes `order.events`; the relay publishes `inventory` aggregate rows to `inventory.events`.

**TDD note:** `main.ts` is thin composition of already-tested units, and the e2e re-wires the relay/consumer path inline (it never imports `main.ts`, mirroring `services/hello/src/__tests__/hello.e2e.test.ts`). So there is no natural failing-then-passing cycle for `main.ts` itself — write it first (Step 1), then the e2e (Step 2) proves the composed slice end-to-end, and the smoke-run (Step 5) exercises `main.ts` as shipped.

- [ ] **Step 1: Write `services/inventory/src/main.ts`**

```ts
import { createApp } from "./app";
import { config } from "./config";
import { outboxPort } from "./outbox-adapter";
import { handleOrderEvent } from "./consumer";
import { startExpirySweeper } from "./sweeper";
import { prisma } from "./db";
import {
  createKafka,
  createProducer,
  createConsumer,
  startOutboxRelay,
  createLogger,
  gracefulShutdown,
  getRedis,
} from "@ecom/shared";

const log = createLogger("inventory-main");
const ORDER_TOPIC = "order.events";

async function main() {
  const kafka = createKafka("inventory");
  const producer = createProducer(kafka);
  await producer.connect();

  // Relay drains the outbox; `inventory` aggregate rows go to `inventory.events`.
  const relay = startOutboxRelay(outboxPort, producer, (aggregateType) => `${aggregateType}.events`, {
    intervalMs: 500,
  });

  const consumer = createConsumer(kafka, "inventory-consumers");
  await consumer.connect();
  await consumer.run([ORDER_TOPIC], handleOrderEvent);

  const sweeper = startExpirySweeper(config.SWEEP_INTERVAL_MS);

  const app = createApp();
  const server = app.listen(config.PORT, () => log.info("inventory_listening", { port: config.PORT }));

  // Closers run in REVERSE registration order: stop accepting traffic first,
  // then the consumer/relay/sweeper/producer, then the backing stores.
  gracefulShutdown([
    async () => void server.close(),
    async () => void consumer.disconnect(),
    async () => relay.stop(),
    async () => sweeper.stop(),
    async () => void producer.disconnect(),
    async () => void (await getRedis()).quit(),
    async () => void prisma.$disconnect(),
  ]);
}

main().catch((e) => {
  log.error("inventory_fatal", { message: (e as Error).message });
  process.exit(1);
});
```

- [ ] **Step 2: Write the slice e2e test** — `services/inventory/src/__tests__/inventory.e2e.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { outboxPort } from "../outbox-adapter";
import { handleOrderEvent } from "../consumer";
import { prisma } from "../db";
import {
  createKafka,
  createProducer,
  createConsumer,
  startOutboxRelay,
  getRedis,
} from "@ecom/shared";
import {
  makeEnvelope,
  ORDER_PLACED,
  INVENTORY_RESERVED,
  type EventEnvelope,
} from "@ecom/contracts";

const ORDER_TOPIC = "order.events";
const INVENTORY_TOPIC = "inventory.events";

describe("inventory slice e2e (needs docker compose up + migrated)", () => {
  const kafka = createKafka("inventory-e2e");
  const producer = createProducer(kafka); // publishes OrderPlaced to order.events
  const orderConsumer = createConsumer(kafka, `inv-e2e-order-${Date.now()}`);
  const invConsumer = createConsumer(kafka, `inv-e2e-inv-${Date.now()}`);
  let relay: { stop: () => void };
  const reserved: EventEnvelope[] = [];

  beforeAll(async () => {
    // Pre-create both topics before subscribing (avoids KafkaJS's auto-create
    // race on fresh topics — see hello.e2e.test.ts for the same fix).
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [
        { topic: ORDER_TOPIC, numPartitions: 1, replicationFactor: 1 },
        { topic: INVENTORY_TOPIC, numPartitions: 1, replicationFactor: 1 },
      ],
    });
    await admin.disconnect();

    await producer.connect();
    relay = startOutboxRelay(outboxPort, producer, (aggregateType) => `${aggregateType}.events`, {
      intervalMs: 300,
    });

    await orderConsumer.connect();
    await orderConsumer.run([ORDER_TOPIC], handleOrderEvent);

    await invConsumer.connect();
    await invConsumer.run([INVENTORY_TOPIC], async (env) => {
      if (env.type === INVENTORY_RESERVED) reserved.push(env);
    });
  });

  afterAll(async () => {
    relay.stop();
    await orderConsumer.disconnect();
    await invConsumer.disconnect();
    await producer.disconnect();
    (await getRedis()).quit();
    await prisma.$disconnect();
  });

  it("OrderPlaced on order.events -> InventoryReserved on inventory.events + stock decremented", async () => {
    const productId = `p_${randomUUID()}`;
    const orderId = `o_${randomUUID()}`;
    await prisma.inventory.create({ data: { productId, available: 10 } });

    await producer.publish(
      ORDER_TOPIC,
      makeEnvelope({
        type: ORDER_PLACED,
        version: 1,
        traceId: "e2e-1",
        producer: "test",
        payload: { orderId, items: [{ productId, quantity: 4 }] },
      })
    );

    const deadline = Date.now() + 25_000;
    while (!reserved.some((e) => (e.payload as { orderId: string }).orderId === orderId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
    }

    expect(reserved.some((e) => (e.payload as { orderId: string }).orderId === orderId)).toBe(true);
    expect((await prisma.inventory.findUnique({ where: { productId } }))?.available).toBe(6);
  });
});
```

- [ ] **Step 3: Run the e2e to verify it passes**

Run: `pnpm vitest run services/inventory/src/__tests__/inventory.e2e.test.ts`
Expected: PASS (1 test) — `OrderPlaced` on `order.events` yields `InventoryReserved` on `inventory.events` and decrements stock.

- [ ] **Step 4: Typecheck the whole service**

Run: `pnpm --filter @ecom/inventory typecheck`
Expected: no errors.

- [ ] **Step 5: Smoke-run the service** (optional manual verification of `main.ts`)

Run: `pnpm --filter @ecom/inventory start`
Expected: logs `inventory_listening`. `curl localhost:3001/readyz` returns 200. Ctrl-C exits cleanly (graceful shutdown). Stop before committing.

- [ ] **Step 6: Commit**

```bash
git add services/inventory/src/main.ts services/inventory/src/__tests__/inventory.e2e.test.ts
git commit -m "feat(inventory): main wiring (consumer + relay + sweeper) + slice e2e"
```

---

### Task 9: Dockerfile + prod compose profile

**Files:**
- Create: `services/inventory/Dockerfile`, `services/inventory/.dockerignore`
- Modify: `docker-compose.example.yml` (add the `inventory` service block)

**Interfaces:**
- Produces: a multi-stage image mirroring `services/hello`, and an `inventory` compose service under the `app` profile so `docker compose --profile app up` runs it against the shared stack.

- [ ] **Step 1: Create `services/inventory/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

# Runtime executes the TypeScript entrypoint directly via tsx (see CMD), so there
# is NO tsc build step: @ecom/shared and @ecom/contracts are consumed as source
# through their package `main: src/index.ts`. A full install is used (not
# `--filter @ecom/inventory...`) because tsx lives in the ROOT devDependencies.
FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/inventory ./services/inventory
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ecom/inventory exec prisma generate

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/services/inventory
EXPOSE 3001
CMD ["pnpm", "exec", "tsx", "src/main.ts"]
```

- [ ] **Step 2: Create `services/inventory/.dockerignore`**

```gitignore
node_modules
dist
.env
```

- [ ] **Step 3: Add the `inventory` service to `docker-compose.example.yml`** (append under `services:`, after the `hello` block; do NOT touch `docker-compose.yml`)

```yaml
  inventory:
    profiles: ["app"]
    build:
      context: .
      dockerfile: services/inventory/Dockerfile
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-ecom}:${POSTGRES_PASSWORD:-ecom}@postgres:5432/inventory
      KAFKA_BROKERS: kafka:19092
      REDIS_URL: redis://redis:6379
      RESERVATION_TTL_MS: 900000
      SWEEP_INTERVAL_MS: 5000
      PORT: 3001
    ports: ["3001:3001"]
    depends_on:
      postgres: { condition: service_healthy }
      kafka: { condition: service_healthy }
      redis: { condition: service_healthy }
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3001/readyz || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 10
```

- [ ] **Step 4: Verify the compose file is valid**

Run: `docker compose -f docker-compose.example.yml config >/dev/null && echo OK`
Expected: prints `OK` (no YAML/schema error).

- [ ] **Step 5: Commit** (compose EXAMPLE only — the real `docker-compose.yml` stays gitignored)

```bash
git add services/inventory/Dockerfile services/inventory/.dockerignore docker-compose.example.yml
git status   # confirm docker-compose.yml is NOT staged
git commit -m "chore(inventory): multi-stage Dockerfile + prod compose profile"
```

---

## Definition of Done (whole plan)

- `pnpm -r typecheck` and `pnpm test` green (unit + integration + e2e; integration/e2e require the stack up + migrated).
- `POST /inventory/stock` + `GET /inventory/:productId` live; `order.events` consumer reserves/releases correctly and idempotently.
- `InventoryReserved` / `InventoryReservationFailed` / `InventoryReleased` land on `inventory.events` via the outbox relay.
- Expiry sweeper auto-releases stranded reservations.
- Multi-item reserve is all-or-nothing; insufficient stock is a business emit, never a DLQ throw.
- Dockerfile builds; `inventory` runs under the `app` compose profile with a healthy `/readyz`.
