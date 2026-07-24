# Phase 4 · Catalog (products + projection + comments + discounts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a `catalog` service (products + comments + discounts) emitting `catalog.events`, and replace Order's `POST /admin/catalog` price stand-in with a version-guarded projection.

**Architecture:** Catalog mirrors the payment/inventory service pattern (Express + Prisma + own DB + transactional outbox → Kafka `catalog.events`), with a **constant `topicFor: () => "catalog.events"`** and no Rabbit (it only produces events). Order gains a **separate** `order-catalog-projection` consumer group that applies `product_created`/`product_updated` via a single atomic `INSERT … ON CONFLICT (productId) DO UPDATE … WHERE EXCLUDED.version > version` upsert — idempotent, out-of-order- and concurrency-safe, needing no `ProcessedEvent`.

**Tech Stack:** TypeScript, Express, Prisma (Postgres), KafkaJS via `@ecom/shared`, zod via `@ecom/contracts`, Vitest + supertest.

**Reference spec:** `docs/superpowers/specs/2026-07-24-phase-4-catalog-design.md`

## Global Constraints

- **Projection upsert = single atomic `INSERT … ON CONFLICT ("productId") DO UPDATE SET … WHERE EXCLUDED.version > "CatalogReadModel".version`** via bound-param `$executeRaw` (never `$executeRawUnsafe`). No `ProcessedEvent` for the projection — the version guard is the dedup.
- **Product `version` bumps on EVERY mutation** (create=1, each PATCH `increment 1`); it rides in the event **payload** `{productId,name,price,version}`. (The outbox row's own `version` column is the envelope/schema version — leave it at its default 1.)
- **Event routing:** catalog outbox rows use `aggregateType:"product"`, `aggregateId:productId`, `producer:"catalog"`; the relay is started with `topicFor: () => "catalog.events"`.
- **Emission:** create → `catalog.product_created`; PATCH → `catalog.product_updated`; **if `price` changed**, ALSO `catalog.price_changed`. The projection consumes created/updated only; ignores price_changed.
- **`type` immutable** after create; PATCH validates `attributes` against the **stored** type. Money = integer minor units.
- **Discount `apply` locks the discount row** (`SELECT … FOR UPDATE`) inside the tx before counting redemptions + inserting — prevents over-redemption under concurrent HTTP.
- **`POST /admin/catalog` on Order is REMOVED**; every test that seeded a price through it migrates to a direct `prisma.catalogReadModel.upsert`.
- **Discounts never touch checkout** (locked). **No auth** on any Catalog endpoint (Phase 6). **Logging ids-only.** Migrations CLI-only. Per-service `.env` gitignored → pass `DATABASE_URL` inline in tests.
- **Per-service test DBs:** run the regression gate per service (one Vitest process can't hold multiple `DATABASE_URL`s).

---

## File Structure

- **New service `services/catalog/`:** `package.json`, `tsconfig.json`, `Dockerfile` (clone payment's); `prisma/schema.prisma` (Product, Comment, Discount, DiscountRedemption, Outbox, ProcessedEvent); `src/{config,db,outbox-adapter,main,app}.ts` (clone payment's, adapt); `src/attributes.ts`, `src/product.ts`, `src/tx-adapters.ts`, `src/comments.ts`, `src/discount.ts`; `src/__tests__/*`.
- **Modify** `packages/contracts/src/events/catalog.ts` (new) + `index.ts`; test.
- **Modify** `services/order/`: `prisma/schema.prisma` (+`CatalogReadModel.version`) + migration; `src/catalog-projection.ts` (new) + `src/tx-adapters.ts` (+`catalogProjectionTx`) + `src/main.ts` (2nd consumer); `src/app.ts` (remove `/admin/catalog`); migrate 6 test files.
- **Modify** `docker-compose.example.yml` (catalog app entry) + `.github/workflows/ci.yml` (catalog step). **Create** `docs/runbooks/phase-4-catalog-demo.md`.

---

### Task 1: Contracts — `catalog.events`

**Files:**
- Create: `packages/contracts/src/events/catalog.ts`; modify `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/__tests__/catalog-events.test.ts`

**Interfaces — Produces:** `CATALOG_PRODUCT_CREATED/UPDATED`, `CATALOG_PRICE_CHANGED`; `ProductCreatedPayloadSchema`/`ProductUpdatedPayloadSchema` `{productId,name,price,version}`; `PriceChangedPayloadSchema` `{productId,price,version}` + types.

- [ ] **Step 1: Failing test** — create `packages/contracts/src/__tests__/catalog-events.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  CATALOG_PRODUCT_CREATED, CATALOG_PRODUCT_UPDATED, CATALOG_PRICE_CHANGED,
  ProductCreatedPayloadSchema, PriceChangedPayloadSchema,
} from "../events/catalog";

describe("catalog contracts", () => {
  it("type strings", () => {
    expect(CATALOG_PRODUCT_CREATED).toBe("catalog.product_created");
    expect(CATALOG_PRODUCT_UPDATED).toBe("catalog.product_updated");
    expect(CATALOG_PRICE_CHANGED).toBe("catalog.price_changed");
  });
  it("product payload validates {productId,name,price,version}", () => {
    expect(ProductCreatedPayloadSchema.parse({ productId: "p1", name: "x", price: 500, version: 1 }))
      .toEqual({ productId: "p1", name: "x", price: 500, version: 1 });
    expect(ProductCreatedPayloadSchema.safeParse({ productId: "p1", name: "x", price: 0, version: 1 }).success).toBe(false);
    expect(ProductCreatedPayloadSchema.safeParse({ productId: "p1", name: "x", price: 500, version: 0 }).success).toBe(false);
  });
  it("price_changed payload validates {productId,price,version}", () => {
    expect(PriceChangedPayloadSchema.parse({ productId: "p1", price: 500, version: 2 }))
      .toEqual({ productId: "p1", price: 500, version: 2 });
    expect(PriceChangedPayloadSchema.safeParse({ productId: "p1", price: 500 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `pnpm vitest run packages/contracts/src/__tests__/catalog-events.test.ts`
- [ ] **Step 3: Implement** — create `packages/contracts/src/events/catalog.ts`:

```ts
import { z } from "zod";

export const CATALOG_PRODUCT_CREATED = "catalog.product_created" as const;
export const CATALOG_PRODUCT_UPDATED = "catalog.product_updated" as const;
export const CATALOG_PRICE_CHANGED = "catalog.price_changed" as const;

const ProductUpsertPayload = z.object({
  productId: z.string().min(1),
  name: z.string().min(1),
  price: z.number().int().positive(),
  version: z.number().int().positive(),
});
export const ProductCreatedPayloadSchema = ProductUpsertPayload;
export const ProductUpdatedPayloadSchema = ProductUpsertPayload;
export type ProductUpsertPayload = z.infer<typeof ProductUpsertPayload>;

export const PriceChangedPayloadSchema = z.object({
  productId: z.string().min(1),
  price: z.number().int().positive(),
  version: z.number().int().positive(),
});
export type PriceChangedPayload = z.infer<typeof PriceChangedPayloadSchema>;
```

Add to `packages/contracts/src/index.ts`: `export * from "./events/catalog";`

- [ ] **Step 4: Run — expect PASS.** `pnpm vitest run packages/contracts/src/__tests__/catalog-events.test.ts`
- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/events/catalog.ts packages/contracts/src/index.ts packages/contracts/src/__tests__/catalog-events.test.ts
git commit -m "feat(contracts): catalog product/price events"
```

---

### Task 2: Catalog service scaffold + schema + attribute validation

**Files:**
- Create: `services/catalog/{package.json,tsconfig.json,Dockerfile}`, `services/catalog/prisma/schema.prisma`, `services/catalog/src/{config,db,outbox-adapter}.ts`, `services/catalog/src/attributes.ts`
- Test: `services/catalog/src/__tests__/attributes.unit.test.ts`

**Interfaces — Produces:** `ATTRIBUTE_SCHEMAS`, `ProductType`, `validateAttributes(type, attrs): { ok: true; value: Record<string,unknown> } | { ok: false; error: string }`.

- [ ] **Step 1: Scaffold the service** (clone payment, adapt):
  - `services/catalog/package.json`: copy `services/payment/package.json`, rename to `@ecom/catalog`, keep the same scripts/deps (no extra deps).
  - `services/catalog/tsconfig.json` + `Dockerfile`: copy payment's; in the Dockerfile replace every `payment` with `catalog` and `EXPOSE 3003`→`EXPOSE 3004`.
  - `services/catalog/src/config.ts`: copy payment's config but **drop `RABBITMQ_URL`** and set `PORT` default `3004`:

```ts
import { z } from "zod";
import { loadConfig } from "@ecom/shared";
export const config = loadConfig(
  z.object({
    DATABASE_URL: z.string().url(),
    KAFKA_BROKERS: z.string().default("localhost:9092"),
    PORT: z.coerce.number().int().positive().default(3004),
    LOG_LEVEL: z.string().default("info"),
  })
);
```
  - `services/catalog/src/db.ts` + `src/outbox-adapter.ts`: copy payment's verbatim (they reference `./generated/prisma` and `./db` — path-relative, no change).

- [ ] **Step 2: Prisma schema** — create `services/catalog/prisma/schema.prisma` (generator+datasource copied from payment; all models defined now so there's one migration):

```prisma
generator client { provider = "prisma-client-js"  output = "../src/generated/prisma" }
datasource db { provider = "postgresql"  url = env("DATABASE_URL") }

model Product {
  id         String   @id @default(uuid())
  type       String
  name       String
  price      Int
  version    Int      @default(1)
  attributes Json
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  comments   Comment[]
}

model Comment {
  id        String   @id @default(uuid())
  productId String
  parentId  String?
  body      String
  createdAt DateTime @default(now())
  product   Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  parent    Comment? @relation("thread", fields: [parentId], references: [id], onDelete: Cascade)
  children  Comment[] @relation("thread")
  @@index([productId])
}

model Discount {
  id          String   @id @default(uuid())
  code        String   @unique
  kind        String
  value       Int
  minOrder    Int      @default(0)
  maxUses     Int
  maxPerUser  Int
  expiresAt   DateTime
  createdAt   DateTime @default(now())
  redemptions DiscountRedemption[]
}

model DiscountRedemption {
  id         String   @id @default(uuid())
  discountId String
  userId     String
  createdAt  DateTime @default(now())
  discount   Discount @relation(fields: [discountId], references: [id], onDelete: Cascade)
  @@index([discountId, userId])
}

model Outbox {
  id String @id @default(uuid())
  aggregateType String
  aggregateId String
  type String
  version Int @default(1)
  traceId String
  producer String
  payload Json
  occurredAt DateTime @default(now())
  sentAt DateTime?
  @@index([sentAt])
}

model ProcessedEvent {
  eventId String @id
  type String
  processedAt DateTime @default(now())
}
```

Run: `pnpm install` (registers the new workspace package), then
`DATABASE_URL='postgresql://ecom:ecom@localhost:5432/catalog' pnpm --filter @ecom/catalog exec prisma migrate dev --name catalog_init`
Then `pnpm --filter @ecom/catalog exec prisma generate`.

- [ ] **Step 3: Failing attribute test** — create `services/catalog/src/__tests__/attributes.unit.test.ts` (fields transcribed from `legacy/src/models/product.model.js`: required field per type + optional rest; furniture `material` mapped to string — legacy had Number, a modeling bug, documented here):

```ts
import { describe, it, expect } from "vitest";
import { validateAttributes } from "../attributes";

const GOLDEN = {
  ELECTRONICS: { manufacturer: "Acme", model: "X1", color: "black" },
  CLOTHING: { brand: "Acme", size: "M", material: "cotton", color: "blue" },
  FURNITURE: { brand: "Acme", size: "L", material: "oak" },
  MOTORBIKE: { manufacturer: "Acme", model: "R1", color: "red" },
} as const;

describe("validateAttributes (golden from legacy factory)", () => {
  for (const [type, attrs] of Object.entries(GOLDEN)) {
    it(`accepts a valid ${type} sample`, () => {
      const r = validateAttributes(type, attrs);
      expect(r.ok).toBe(true);
    });
  }
  it("rejects a missing required field (ELECTRONICS.manufacturer)", () => {
    expect(validateAttributes("ELECTRONICS", { model: "X1" }).ok).toBe(false);
  });
  it("rejects an unknown type", () => {
    expect(validateAttributes("SPACESHIP", {}).ok).toBe(false);
  });
  it("accepts only the required field (optionals omitted)", () => {
    expect(validateAttributes("CLOTHING", { brand: "Acme" }).ok).toBe(true);
  });
});
```

- [ ] **Step 4: Run — expect FAIL** (`attributes.ts` missing). `DATABASE_URL='postgresql://ecom:ecom@localhost:5432/catalog' pnpm vitest run services/catalog/src/__tests__/attributes.unit.test.ts`

- [ ] **Step 5: Implement** — create `services/catalog/src/attributes.ts`:

```ts
import { z } from "zod";

// Transcribed from legacy/src/models/product.model.js. Each legacy sub-schema had
// exactly one required field; the rest optional. (Legacy furniture.material was a
// Number — a modeling bug; mapped to string here.)
export const ATTRIBUTE_SCHEMAS = {
  ELECTRONICS: z.object({
    manufacturer: z.string().min(1),
    model: z.string().min(1).optional(),
    color: z.string().min(1).optional(),
  }),
  CLOTHING: z.object({
    brand: z.string().min(1),
    size: z.string().min(1).optional(),
    material: z.string().min(1).optional(),
    color: z.string().min(1).optional(),
  }),
  FURNITURE: z.object({
    brand: z.string().min(1),
    size: z.string().min(1).optional(),
    material: z.string().min(1).optional(),
  }),
  MOTORBIKE: z.object({
    manufacturer: z.string().min(1),
    model: z.string().min(1).optional(),
    color: z.string().min(1).optional(),
  }),
} as const;

export type ProductType = keyof typeof ATTRIBUTE_SCHEMAS;

export function isProductType(t: string): t is ProductType {
  return t in ATTRIBUTE_SCHEMAS;
}

export function validateAttributes(
  type: string,
  attrs: unknown
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!isProductType(type)) return { ok: false, error: "unknown_type" };
  const r = ATTRIBUTE_SCHEMAS[type].safeParse(attrs);
  return r.success
    ? { ok: true, value: r.data as Record<string, unknown> }
    : { ok: false, error: "invalid_attributes" };
}
```

- [ ] **Step 6: Run — expect PASS** + typecheck. `DATABASE_URL=… pnpm vitest run services/catalog/src/__tests__/attributes.unit.test.ts` ; `pnpm --filter @ecom/catalog typecheck`
- [ ] **Step 7: Commit**

```bash
git add services/catalog/package.json services/catalog/tsconfig.json services/catalog/Dockerfile services/catalog/prisma services/catalog/src/config.ts services/catalog/src/db.ts services/catalog/src/outbox-adapter.ts services/catalog/src/attributes.ts services/catalog/src/__tests__/attributes.unit.test.ts pnpm-lock.yaml
git commit -m "feat(catalog): service scaffold + schema + per-type attribute validation"
```

---

### Task 3: Catalog product write core + CRUD + events + main

**Files:**
- Create: `services/catalog/src/product.ts`, `services/catalog/src/tx-adapters.ts`, `services/catalog/src/app.ts`, `services/catalog/src/main.ts`
- Test: `services/catalog/src/__tests__/product.unit.test.ts`, `services/catalog/src/__tests__/product.int.test.ts`

**Interfaces — Produces:** `ProductWriteTx { createProduct(data): Promise<{id,version}>; loadForUpdate(id): Promise<{type,price} | null>; updateProduct(id, data): Promise<{version,price}>; enqueue(type, productId, payload): Promise<void> }`; `applyCreate(tx,{type,name,price,attributes})`, `applyUpdate(tx,{id,name?,price?,attributes?})` domain cores; `productTx(tx, traceId)`.

- [ ] **Step 1: Failing unit test** — create `services/catalog/src/__tests__/product.unit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applyCreate, applyUpdate, type ProductWriteTx } from "../product";
import { CATALOG_PRODUCT_CREATED, CATALOG_PRODUCT_UPDATED, CATALOG_PRICE_CHANGED } from "@ecom/contracts";

function fakeTx(init?: { type?: string; price?: number; exists?: boolean }) {
  const emitted: Array<{ type: string; payload: any }> = [];
  let price = init?.price ?? 500;
  const type = init?.type ?? "ELECTRONICS";
  const exists = init?.exists ?? true;
  let version = 1;
  const tx: ProductWriteTx = {
    async createProduct() { return { id: "p1", version: 1 }; },
    async loadForUpdate() { return exists ? { type, price } : null; },
    async updateProduct(_id, data) { version += 1; if (data.price !== undefined) price = data.price; return { version, price }; },
    async enqueue(t, _p, payload) { emitted.push({ type: t, payload }); },
  };
  return { tx, emitted };
}

describe("applyCreate", () => {
  it("creates + emits product_created(version 1)", async () => {
    const f = fakeTx();
    const r = await applyCreate(f.tx, { type: "ELECTRONICS", name: "x", price: 700, attributes: { manufacturer: "Acme" } });
    expect(r).toEqual({ ok: true, productId: "p1" });
    expect(f.emitted).toEqual([{ type: CATALOG_PRODUCT_CREATED, payload: { productId: "p1", name: "x", price: 700, version: 1 } }]);
  });
  it("rejects invalid attributes without emitting", async () => {
    const f = fakeTx();
    const r = await applyCreate(f.tx, { type: "ELECTRONICS", name: "x", price: 700, attributes: {} });
    expect(r.ok).toBe(false);
    expect(f.emitted).toEqual([]);
  });
});

describe("applyUpdate", () => {
  it("price change emits product_updated AND price_changed", async () => {
    const f = fakeTx({ price: 500 });
    const r = await applyUpdate(f.tx, { id: "p1", price: 900 });
    expect(r.ok).toBe(true);
    expect(f.emitted).toEqual([
      { type: CATALOG_PRODUCT_UPDATED, payload: { productId: "p1", name: undefined, price: 900, version: 2 } },
      { type: CATALOG_PRICE_CHANGED, payload: { productId: "p1", price: 900, version: 2 } },
    ]);
  });
  it("name-only change emits product_updated ONLY (no price_changed)", async () => {
    const f = fakeTx({ price: 500 });
    await applyUpdate(f.tx, { id: "p1", name: "y" });
    expect(f.emitted.map((e) => e.type)).toEqual([CATALOG_PRODUCT_UPDATED]);
  });
  it("unknown product -> NOT_FOUND", async () => {
    const f = fakeTx({ exists: false });
    expect((await applyUpdate(f.tx, { id: "x", price: 1 })).ok).toBe(false);
  });
});
```

> NOTE for the implementer: `product_updated`'s payload carries the resolved `name` and `price` after the write. In the unit fake, `name` is `undefined` when not provided — in the real `productTx.updateProduct` the row's post-update `name`/`price` are returned and used, so the emitted payload is always concrete. Assert against the fake's behavior here; the int test (Step 4) asserts the concrete DB values.

- [ ] **Step 2: Run — expect FAIL.** `DATABASE_URL=… pnpm vitest run services/catalog/src/__tests__/product.unit.test.ts`

- [ ] **Step 3a: Implement the core** — create `services/catalog/src/product.ts`:

```ts
import {
  CATALOG_PRODUCT_CREATED, CATALOG_PRODUCT_UPDATED, CATALOG_PRICE_CHANGED,
} from "@ecom/contracts";
import { validateAttributes } from "./attributes";

export interface ProductWriteTx {
  createProduct(data: { type: string; name: string; price: number; attributes: unknown }): Promise<{ id: string; version: number }>;
  loadForUpdate(id: string): Promise<{ type: string; name: string; price: number } | null>;
  updateProduct(id: string, data: { name?: string; price?: number; attributes?: unknown }): Promise<{ name: string; price: number; version: number }>;
  enqueue(type: string, productId: string, payload: unknown): Promise<void>;
}

export async function applyCreate(
  tx: ProductWriteTx,
  p: { type: string; name: string; price: number; attributes: unknown }
): Promise<{ ok: true; productId: string } | { ok: false; error: string }> {
  const attrs = validateAttributes(p.type, p.attributes);
  if (!attrs.ok) return { ok: false, error: attrs.error };
  const { id, version } = await tx.createProduct({ type: p.type, name: p.name, price: p.price, attributes: attrs.value });
  await tx.enqueue(CATALOG_PRODUCT_CREATED, id, { productId: id, name: p.name, price: p.price, version });
  return { ok: true, productId: id };
}

export async function applyUpdate(
  tx: ProductWriteTx,
  p: { id: string; name?: string; price?: number; attributes?: unknown }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const cur = await tx.loadForUpdate(p.id);
  if (cur === null) return { ok: false, error: "not_found" };
  if (p.attributes !== undefined) {
    const attrs = validateAttributes(cur.type, p.attributes);
    if (!attrs.ok) return { ok: false, error: attrs.error };
    p = { ...p, attributes: attrs.value };
  }
  const priceChanged = p.price !== undefined && p.price !== cur.price;
  const after = await tx.updateProduct(p.id, { name: p.name, price: p.price, attributes: p.attributes });
  await tx.enqueue(CATALOG_PRODUCT_UPDATED, p.id, { productId: p.id, name: after.name, price: after.price, version: after.version });
  if (priceChanged) {
    await tx.enqueue(CATALOG_PRICE_CHANGED, p.id, { productId: p.id, price: after.price, version: after.version });
  }
  return { ok: true };
}
```

> The unit test's fake `updateProduct` returns `name` unchanged-as-undefined; the assertion in Step 1 matches that. The real adapter returns the concrete row (below).

- [ ] **Step 3b: Port** — create `services/catalog/src/tx-adapters.ts`:

```ts
import { Prisma } from "./generated/prisma";
import type { ProductWriteTx } from "./product";

export function productTx(tx: Prisma.TransactionClient, traceId: string): ProductWriteTx {
  return {
    async createProduct(data) {
      const p = await tx.product.create({
        data: { type: data.type, name: data.name, price: data.price, attributes: data.attributes as Prisma.InputJsonValue },
      });
      return { id: p.id, version: p.version };
    },
    async loadForUpdate(id) {
      const p = await tx.product.findUnique({ where: { id }, select: { type: true, name: true, price: true } });
      return p ?? null;
    },
    async updateProduct(id, data) {
      const p = await tx.product.update({
        where: { id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.price !== undefined ? { price: data.price } : {}),
          ...(data.attributes !== undefined ? { attributes: data.attributes as Prisma.InputJsonValue } : {}),
          version: { increment: 1 },
        },
        select: { name: true, price: true, version: true },
      });
      return p;
    },
    async enqueue(type, productId, payload) {
      await tx.outbox.create({
        data: { aggregateType: "product", aggregateId: productId, type, traceId, producer: "catalog", payload: payload as Prisma.InputJsonValue },
      });
    },
  };
}
```

- [ ] **Step 3c: App** — create `services/catalog/src/app.ts` (clone the shape of payment's `createApp` — `express.json()`, `traceMiddleware()`, `createHealthRouter({ db })`; NO rabbit health). Routes:

```ts
import express from "express";
import { z } from "zod";
import { traceMiddleware, createLogger, createHealthRouter } from "@ecom/shared";
import { prisma } from "./db";
import { applyCreate, applyUpdate } from "./product";
import { productTx } from "./tx-adapters";

const log = createLogger("catalog");
const CreateSchema = z.object({ type: z.string().min(1), name: z.string().min(1), price: z.number().int().positive(), attributes: z.record(z.unknown()) });
const PatchSchema = z.object({ name: z.string().min(1).optional(), price: z.number().int().positive().optional(), attributes: z.record(z.unknown()).optional() });

export function createApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(traceMiddleware());
  app.use(createHealthRouter({ db: async () => void (await prisma.$queryRaw`SELECT 1`) }));

  app.post("/products", async (req, res) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid product" });
    try {
      const r = await prisma.$transaction((tx) => applyCreate(productTx(tx, req.traceId), parsed.data));
      if (!r.ok) return res.status(400).json({ error: r.error });
      log.info("product_created", { productId: r.productId, traceId: req.traceId });
      return res.status(201).json({ productId: r.productId });
    } catch { log.error("product_create_failed", { traceId: req.traceId }); res.status(500).json({ error: "internal error" }); }
  });

  app.patch("/products/:id", async (req, res) => {
    const parsed = PatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid patch" });
    try {
      const r = await prisma.$transaction((tx) => applyUpdate(productTx(tx, req.traceId), { id: req.params.id, ...parsed.data }));
      if (!r.ok) return res.status(r.error === "not_found" ? 404 : 400).json({ error: r.error });
      log.info("product_updated", { productId: req.params.id, traceId: req.traceId });
      return res.status(200).json({ productId: req.params.id });
    } catch { log.error("product_update_failed", { productId: req.params.id, traceId: req.traceId }); res.status(500).json({ error: "internal error" }); }
  });

  app.get("/products/:id", async (req, res) => {
    const p = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!p) return res.status(404).json({ error: "not found" });
    res.json({ id: p.id, type: p.type, name: p.name, price: p.price, version: p.version, attributes: p.attributes });
  });
  app.get("/products", async (_req, res) => {
    const rows = await prisma.product.findMany({ orderBy: { createdAt: "asc" } });
    res.json(rows.map((p) => ({ id: p.id, type: p.type, name: p.name, price: p.price, version: p.version })));
  });

  return app;
}
```

- [ ] **Step 3d: Main** — create `services/catalog/src/main.ts` (clone payment's, minus Rabbit; **constant `topicFor`**):

```ts
import { createApp } from "./app";
import { config } from "./config";
import { outboxPort } from "./outbox-adapter";
import { prisma } from "./db";
import { createKafka, createProducer, startOutboxRelay, createLogger, gracefulShutdown } from "@ecom/shared";

const log = createLogger("catalog-main");

async function main() {
  const kafka = createKafka("catalog");
  const producer = createProducer(kafka);
  await producer.connect();
  const relay = startOutboxRelay(outboxPort, producer, () => "catalog.events", { intervalMs: 500 });
  const app = createApp();
  const server = app.listen(config.PORT, () => log.info("catalog_listening", { port: config.PORT }));
  gracefulShutdown([
    async () => { await prisma.$disconnect(); },
    async () => { await producer.disconnect(); },
    async () => { relay.stop(); },
    async () => { await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))); },
  ]);
}
main().catch((e) => { log.error("catalog_fatal", { message: (e as Error).message }); process.exit(1); });
```

- [ ] **Step 4: Failing int test** — create `services/catalog/src/__tests__/product.int.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../db";
import { CATALOG_PRODUCT_CREATED, CATALOG_PRODUCT_UPDATED, CATALOG_PRICE_CHANGED } from "@ecom/contracts";

const app = createApp();
const outbox = (pid: string, type: string) => prisma.outbox.count({ where: { aggregateId: pid, type } });

describe("catalog product CRUD + events (integration)", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("POST /products -> product_created; PATCH price -> product_updated + price_changed", async () => {
    const create = await request(app).post("/products").send({ type: "ELECTRONICS", name: "Widget", price: 500, attributes: { manufacturer: "Acme" } });
    expect(create.status).toBe(201);
    const pid = create.body.productId;
    expect(await outbox(pid, CATALOG_PRODUCT_CREATED)).toBe(1);

    const patch = await request(app).patch(`/products/${pid}`).send({ price: 900 });
    expect(patch.status).toBe(200);
    expect(await outbox(pid, CATALOG_PRODUCT_UPDATED)).toBe(1);
    expect(await outbox(pid, CATALOG_PRICE_CHANGED)).toBe(1);
    const p = await prisma.product.findUnique({ where: { id: pid } });
    expect(p!.version).toBe(2);
  });

  it("name-only PATCH emits no price_changed", async () => {
    const create = await request(app).post("/products").send({ type: "CLOTHING", name: "Shirt", price: 300, attributes: { brand: "Acme" } });
    const pid = create.body.productId;
    await request(app).patch(`/products/${pid}`).send({ name: "Shirt v2" });
    expect(await outbox(pid, CATALOG_PRICE_CHANGED)).toBe(0);
  });

  it("invalid attributes -> 400, no product", async () => {
    const r = await request(app).post("/products").send({ type: "ELECTRONICS", name: "x", price: 100, attributes: {} });
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 5: Migrate deploy + run unit & int + typecheck.**

Run: `DATABASE_URL='postgresql://ecom:ecom@localhost:5432/catalog' pnpm --filter @ecom/catalog exec prisma migrate deploy`
Run: `DATABASE_URL='postgresql://ecom:ecom@localhost:5432/catalog' pnpm vitest run services/catalog/src/__tests__/product.unit.test.ts services/catalog/src/__tests__/product.int.test.ts`
Run: `pnpm --filter @ecom/catalog typecheck`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add services/catalog/src/product.ts services/catalog/src/tx-adapters.ts services/catalog/src/app.ts services/catalog/src/main.ts services/catalog/src/__tests__/product.unit.test.ts services/catalog/src/__tests__/product.int.test.ts
git commit -m "feat(catalog): product CRUD + version bump + product/price events"
```

---

### Task 4: Catalog comments (adjacency list)

**Files:**
- Create: `services/catalog/src/comments.ts` (tree assembly), routes in `services/catalog/src/app.ts`
- Test: `services/catalog/src/__tests__/comments.unit.test.ts`, `services/catalog/src/__tests__/comments.int.test.ts`

**Interfaces — Produces:** `assembleTree(rows: {id,parentId,body}[]): CommentNode[]` where `CommentNode = {id, body, children: CommentNode[]}`.

- [ ] **Step 1: Failing unit test** — create `services/catalog/src/__tests__/comments.unit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assembleTree } from "../comments";

describe("assembleTree", () => {
  it("nests children under parents, roots first, insertion order preserved", () => {
    const tree = assembleTree([
      { id: "a", parentId: null, body: "root" },
      { id: "b", parentId: "a", body: "child" },
      { id: "c", parentId: "b", body: "grandchild" },
      { id: "d", parentId: null, body: "root2" },
    ]);
    expect(tree.map((n) => n.id)).toEqual(["a", "d"]);
    expect(tree[0].children[0].id).toBe("b");
    expect(tree[0].children[0].children[0].id).toBe("c");
    expect(tree[1].children).toEqual([]);
  });
  it("orphan (missing parent) is dropped from the forest, not crashed", () => {
    const tree = assembleTree([{ id: "x", parentId: "ghost", body: "orphan" }]);
    expect(tree).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `DATABASE_URL=… pnpm vitest run services/catalog/src/__tests__/comments.unit.test.ts`

- [ ] **Step 3a: Implement** — create `services/catalog/src/comments.ts`:

```ts
export interface CommentRow { id: string; parentId: string | null; body: string; }
export interface CommentNode { id: string; body: string; children: CommentNode[]; }

// Build the forest from a flat product-scoped fetch. O(n): one pass to index, one to link.
export function assembleTree(rows: CommentRow[]): CommentNode[] {
  const nodes = new Map<string, CommentNode>();
  for (const r of rows) nodes.set(r.id, { id: r.id, body: r.body, children: [] });
  const roots: CommentNode[] = [];
  for (const r of rows) {
    const node = nodes.get(r.id)!;
    if (r.parentId === null) roots.push(node);
    else {
      const parent = nodes.get(r.parentId);
      if (parent) parent.children.push(node); // missing parent => orphan dropped
    }
  }
  return roots;
}
```

- [ ] **Step 3b: Routes** — add to `services/catalog/src/app.ts` (after the product routes). Import `assembleTree`:

```ts
  const CommentSchema = z.object({ body: z.string().min(1), parentId: z.string().optional() });

  app.post("/products/:id/comments", async (req, res) => {
    const parsed = CommentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid comment" });
    const product = await prisma.product.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!product) return res.status(404).json({ error: "not found" });
    if (parsed.data.parentId) {
      const parent = await prisma.comment.findUnique({ where: { id: parsed.data.parentId }, select: { productId: true } });
      if (!parent || parent.productId !== req.params.id) return res.status(400).json({ error: "bad parent" });
    }
    const c = await prisma.comment.create({ data: { productId: req.params.id, parentId: parsed.data.parentId ?? null, body: parsed.data.body } });
    res.status(201).json({ id: c.id });
  });

  app.get("/products/:id/comments", async (req, res) => {
    const rows = await prisma.comment.findMany({ where: { productId: req.params.id }, orderBy: { createdAt: "asc" }, select: { id: true, parentId: true, body: true } });
    res.json(assembleTree(rows));
  });

  app.delete("/comments/:id", async (req, res) => {
    const r = await prisma.comment.deleteMany({ where: { id: req.params.id } }); // cascade removes the subtree
    if (r.count === 0) return res.status(404).json({ error: "not found" });
    res.status(200).json({ id: req.params.id });
  });
```

- [ ] **Step 4: Failing int test** — create `services/catalog/src/__tests__/comments.int.test.ts` (property-ish: build a thread, delete a subtree):

```ts
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../db";

const app = createApp();
async function seedProduct(): Promise<string> {
  const r = await request(app).post("/products").send({ type: "ELECTRONICS", name: "P", price: 100, attributes: { manufacturer: "Acme" } });
  return r.body.productId;
}

describe("catalog comments (integration)", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("threads replies and returns the nested tree", async () => {
    const pid = await seedProduct();
    const root = (await request(app).post(`/products/${pid}/comments`).send({ body: "root" })).body.id;
    const child = (await request(app).post(`/products/${pid}/comments`).send({ body: "child", parentId: root })).body.id;
    await request(app).post(`/products/${pid}/comments`).send({ body: "grandchild", parentId: child });
    const tree = (await request(app).get(`/products/${pid}/comments`)).body;
    expect(tree[0].children[0].children[0].body).toBe("grandchild");
  });

  it("DELETE removes the whole subtree (cascade)", async () => {
    const pid = await seedProduct();
    const root = (await request(app).post(`/products/${pid}/comments`).send({ body: "root" })).body.id;
    const child = (await request(app).post(`/products/${pid}/comments`).send({ body: "child", parentId: root })).body.id;
    await request(app).delete(`/comments/${root}`);
    expect(await prisma.comment.count({ where: { id: { in: [root, child] } } })).toBe(0);
  });

  it("bad parent -> 400; unknown product -> 404", async () => {
    const pid = await seedProduct();
    expect((await request(app).post(`/products/${pid}/comments`).send({ body: "x", parentId: "nope" })).status).toBe(400);
    expect((await request(app).post(`/products/ghost/comments`).send({ body: "x" })).status).toBe(404);
  });
});
```

- [ ] **Step 5: Run unit + int + typecheck** (inline DATABASE_URL). Expected green.
- [ ] **Step 6: Commit**

```bash
git add services/catalog/src/comments.ts services/catalog/src/app.ts services/catalog/src/__tests__/comments.unit.test.ts services/catalog/src/__tests__/comments.int.test.ts
git commit -m "feat(catalog): comment thread (adjacency list) CRUD + cascade delete"
```

---

### Task 5: Catalog discounts (rules + row-locked apply)

**Files:**
- Create: `services/catalog/src/discount.ts` (pure `getDiscountAmount`), routes in `services/catalog/src/app.ts`
- Test: `services/catalog/src/__tests__/discount.unit.test.ts`, `services/catalog/src/__tests__/discount.int.test.ts`

**Interfaces — Produces:** `getDiscountAmount(d: DiscountRule, ctx): { amount: number } | { ineligible: string }` where `DiscountRule = {kind:"PERCENT"|"FIXED"; value; minOrder; maxUses; maxPerUser; expiresAt: Date}`, `ctx = {orderTotal; totalUses; userUses; now: Date}`.

- [ ] **Step 1: Failing unit test** — create `services/catalog/src/__tests__/discount.unit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getDiscountAmount } from "../discount";

const base = { kind: "PERCENT" as const, value: 10, minOrder: 100, maxUses: 5, maxPerUser: 1, expiresAt: new Date("2030-01-01") };
const ctx = { orderTotal: 1000, totalUses: 0, userUses: 0, now: new Date("2026-01-01") };

describe("getDiscountAmount", () => {
  it("PERCENT 10% of 1000 = 100", () => { expect(getDiscountAmount(base, ctx)).toEqual({ amount: 100 }); });
  it("FIXED capped at orderTotal", () => { expect(getDiscountAmount({ ...base, kind: "FIXED", value: 5000 }, { ...ctx, orderTotal: 300 })).toEqual({ amount: 300 }); });
  it("expired -> ineligible", () => { expect(getDiscountAmount({ ...base, expiresAt: new Date("2020-01-01") }, ctx)).toEqual({ ineligible: "expired" }); });
  it("below minOrder -> ineligible", () => { expect(getDiscountAmount(base, { ...ctx, orderTotal: 50 })).toEqual({ ineligible: "min_order" }); });
  it("maxUses reached -> ineligible", () => { expect(getDiscountAmount(base, { ...ctx, totalUses: 5 })).toEqual({ ineligible: "max_uses" }); });
  it("maxPerUser reached -> ineligible", () => { expect(getDiscountAmount(base, { ...ctx, userUses: 1 })).toEqual({ ineligible: "max_per_user" }); });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3a: Implement** — create `services/catalog/src/discount.ts`:

```ts
export interface DiscountRule {
  kind: "PERCENT" | "FIXED"; value: number; minOrder: number; maxUses: number; maxPerUser: number; expiresAt: Date;
}
export interface DiscountCtx { orderTotal: number; totalUses: number; userUses: number; now: Date; }

// Pure. Order of checks is stable (expiry -> minOrder -> maxUses -> maxPerUser).
export function getDiscountAmount(
  d: DiscountRule, c: DiscountCtx
): { amount: number } | { ineligible: string } {
  if (c.now >= d.expiresAt) return { ineligible: "expired" };
  if (c.orderTotal < d.minOrder) return { ineligible: "min_order" };
  if (c.totalUses >= d.maxUses) return { ineligible: "max_uses" };
  if (c.userUses >= d.maxPerUser) return { ineligible: "max_per_user" };
  const raw = d.kind === "PERCENT" ? Math.floor((c.orderTotal * d.value) / 100) : d.value;
  return { amount: Math.min(raw, c.orderTotal) };
}
```

- [ ] **Step 3b: Routes** — add to `services/catalog/src/app.ts`. Import `getDiscountAmount` + `Prisma`:

```ts
  const DiscountSchema = z.object({
    code: z.string().min(1), kind: z.enum(["PERCENT", "FIXED"]), value: z.number().int().positive(),
    minOrder: z.number().int().nonnegative().default(0), maxUses: z.number().int().positive(),
    maxPerUser: z.number().int().positive(), expiresAt: z.string().datetime(),
  });
  const ApplySchema = z.object({ userId: z.string().min(1), orderTotal: z.number().int().positive() });

  app.post("/discounts", async (req, res) => {
    const parsed = DiscountSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid discount" });
    try {
      const d = await prisma.discount.create({ data: { ...parsed.data, expiresAt: new Date(parsed.data.expiresAt) } });
      res.status(201).json({ code: d.code });
    } catch { res.status(409).json({ error: "duplicate code" }); }
  });

  app.get("/discounts/:code", async (req, res) => {
    const d = await prisma.discount.findUnique({ where: { code: req.params.code } });
    if (!d) return res.status(404).json({ error: "not found" });
    res.json({ code: d.code, kind: d.kind, value: d.value, minOrder: d.minOrder, maxUses: d.maxUses, maxPerUser: d.maxPerUser, expiresAt: d.expiresAt.toISOString() });
  });

  // Row-locked apply: SELECT ... FOR UPDATE serializes concurrent applies for one code
  // so maxUses/maxPerUser cannot be exceeded (count-then-insert TOCTOU otherwise).
  app.post("/discounts/:code/apply", async (req, res) => {
    const parsed = ApplySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid apply" });
    const { userId, orderTotal } = parsed.data;
    try {
      const result = await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string; kind: string; value: number; minOrder: number; maxUses: number; maxPerUser: number; expiresAt: Date }>>`
          SELECT id, kind, value, "minOrder", "maxUses", "maxPerUser", "expiresAt"
          FROM "Discount" WHERE code = ${req.params.code} FOR UPDATE`;
        if (locked.length === 0) return { status: 404 as const };
        const d = locked[0];
        const totalUses = await tx.discountRedemption.count({ where: { discountId: d.id } });
        const userUses = await tx.discountRedemption.count({ where: { discountId: d.id, userId } });
        const outcome = getDiscountAmount(
          { kind: d.kind as "PERCENT" | "FIXED", value: d.value, minOrder: d.minOrder, maxUses: d.maxUses, maxPerUser: d.maxPerUser, expiresAt: d.expiresAt },
          { orderTotal, totalUses, userUses, now: new Date() }
        );
        if ("ineligible" in outcome) return { status: 409 as const, reason: outcome.ineligible };
        await tx.discountRedemption.create({ data: { discountId: d.id, userId } });
        return { status: 200 as const, amount: outcome.amount };
      });
      if (result.status === 404) return res.status(404).json({ error: "not found" });
      if (result.status === 409) return res.status(409).json({ error: result.reason });
      log.info("discount_applied", { code: req.params.code, userId, traceId: req.traceId });
      return res.status(200).json({ amount: result.amount });
    } catch { log.error("discount_apply_failed", { code: req.params.code, traceId: req.traceId }); res.status(500).json({ error: "internal error" }); }
  });
```

> NOTE: `new Date()` is used for `now` in the apply handler (real wall-clock at request time) — acceptable in service code (the *plan/workflow scripts* forbid `Date.now()`, not the app). The pure core takes `now` injected, so unit tests are deterministic.

- [ ] **Step 4: Failing int test** — create `services/catalog/src/__tests__/discount.int.test.ts` (rules + **concurrency**):

```ts
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { prisma } from "../db";

const app = createApp();
async function mkDiscount(over: Partial<any> = {}): Promise<string> {
  const code = `D_${randomUUID().slice(0, 8)}`;
  await request(app).post("/discounts").send({ code, kind: "PERCENT", value: 10, minOrder: 100, maxUses: 3, maxPerUser: 1, expiresAt: "2030-01-01T00:00:00.000Z", ...over });
  return code;
}

describe("catalog discounts (integration)", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("apply returns amount + records a redemption; per-user limit -> 409", async () => {
    const code = await mkDiscount();
    const u = `u_${randomUUID()}`;
    const r1 = await request(app).post(`/discounts/${code}/apply`).send({ userId: u, orderTotal: 1000 });
    expect(r1.status).toBe(200); expect(r1.body.amount).toBe(100);
    const r2 = await request(app).post(`/discounts/${code}/apply`).send({ userId: u, orderTotal: 1000 });
    expect(r2.status).toBe(409); // maxPerUser=1
  });

  it("concurrent applies never exceed maxUses (row lock)", async () => {
    const code = await mkDiscount({ maxUses: 3, maxPerUser: 10 });
    const applies = Array.from({ length: 10 }, (_, i) =>
      request(app).post(`/discounts/${code}/apply`).send({ userId: `u${i}`, orderTotal: 1000 }));
    const results = await Promise.all(applies);
    const ok = results.filter((r) => r.status === 200).length;
    expect(ok).toBe(3); // exactly maxUses, never more
    const d = await prisma.discount.findUnique({ where: { code }, include: { redemptions: true } });
    expect(d!.redemptions.length).toBe(3);
  });

  it("below minOrder -> 409; unknown code -> 404", async () => {
    const code = await mkDiscount({ minOrder: 500 });
    expect((await request(app).post(`/discounts/${code}/apply`).send({ userId: "u", orderTotal: 100 })).status).toBe(409);
    expect((await request(app).post(`/discounts/nope/apply`).send({ userId: "u", orderTotal: 100 })).status).toBe(404);
  });
});
```

- [ ] **Step 5: Run unit + int + typecheck** (inline DATABASE_URL). The concurrency test proves the row lock. Expected green.
- [ ] **Step 6: Commit**

```bash
git add services/catalog/src/discount.ts services/catalog/src/app.ts services/catalog/src/__tests__/discount.unit.test.ts services/catalog/src/__tests__/discount.int.test.ts
git commit -m "feat(catalog): discount rules + row-locked apply (no over-redemption)"
```

---

### Task 6: Catalog wiring — compose + CI + standalone e2e

**Files:**
- Modify: `docker-compose.example.yml`, `.github/workflows/ci.yml`
- Test: `services/catalog/src/__tests__/catalog.e2e.test.ts`

- [ ] **Step 1: Compose** — add a `catalog` service under the `app` profile in `docker-compose.example.yml` (copy the `payment` block; drop `RABBITMQ_URL` + the rabbitmq dependency; `DATABASE_URL=…/catalog`, `PORT: 3004`, `ports: ["3004:3004"]`, `depends_on: postgres+kafka healthy`, healthcheck `wget -qO- http://localhost:3004/readyz`, `dockerfile: services/catalog/Dockerfile`).

- [ ] **Step 2: CI** — add a `Catalog service (migrate + int/e2e)` step to `.github/workflows/ci.yml` (copy the Payment step; `DATABASE_URL: postgresql://ecom:ecom@localhost:5432/catalog`, `KAFKA_BROKERS: localhost:9092`; run `pnpm --filter @ecom/catalog exec prisma migrate deploy` then `pnpm vitest run services/catalog`).

- [ ] **Step 3: Standalone e2e** — create `services/catalog/src/__tests__/catalog.e2e.test.ts` (real Kafka: relay publishes product events to `catalog.events`; a raw consumer reads them). Model the connect/teardown on `services/payment/src/__tests__/payment.e2e.test.ts` (createKafka/createProducer/createConsumer/startOutboxRelay). Assert:

```ts
// after starting the relay (topicFor: () => "catalog.events") and a consumer on ["catalog.events"]:
it("create + price update land on catalog.events (product_created, product_updated, price_changed)", async () => {
  const seen: string[] = [];
  // consumer handler pushes env.type for the created productId
  const pid = (await request(app).post("/products").send({ type: "ELECTRONICS", name: "E2E", price: 500, attributes: { manufacturer: "Acme" } })).body.productId;
  await request(app).patch(`/products/${pid}`).send({ price: 999 });
  await waitFor(() => seen.filter((t) => t.startsWith("catalog.")).length >= 3);
  expect(seen).toContain("catalog.product_created");
  expect(seen).toContain("catalog.product_updated");
  expect(seen).toContain("catalog.price_changed");
}, 30000);
```
> Provide a `waitFor` poll helper + filter the consumer to this test's productId (the envelope payload carries `productId`). Copy the harness scaffold from `payment.e2e.test.ts` verbatim.

- [ ] **Step 4: Run the e2e** (inline DATABASE_URL, infra up). Expected PASS.
- [ ] **Step 5: Commit**

```bash
git add docker-compose.example.yml .github/workflows/ci.yml services/catalog/src/__tests__/catalog.e2e.test.ts
git commit -m "chore(catalog): compose + CI + standalone e2e (catalog.events)"
```

---

### Task 7: Order projection — `CatalogReadModel.version` + consumer + atomic upsert

**Files:**
- Modify: `services/order/prisma/schema.prisma` (+`version`) + migration; `services/order/src/tx-adapters.ts` (+`catalogProjectionTx`); `services/order/src/main.ts` (2nd consumer)
- Create: `services/order/src/catalog-projection.ts`
- Test: `services/order/src/__tests__/catalog-projection.int.test.ts`

**Interfaces — Produces:** `handleCatalogEvent(env): Promise<void>`; `applyCatalogUpsert(tx, {productId,name,price,version})`; `catalogProjectionTx(tx)`.

- [ ] **Step 1: Schema + migration** — in `services/order/prisma/schema.prisma`, add to `CatalogReadModel`: `version Int @default(0)`. Run:
`DATABASE_URL='postgresql://ecom:ecom@localhost:5432/order' pnpm --filter @ecom/order exec prisma migrate dev --name catalog_read_model_version`
then `pnpm --filter @ecom/order exec prisma generate`.

- [ ] **Step 2: Failing int test** — create `services/order/src/__tests__/catalog-projection.int.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { handleCatalogEvent } from "../catalog-projection";
import { prisma } from "../db";
import { makeEnvelope, CATALOG_PRODUCT_CREATED, CATALOG_PRODUCT_UPDATED, CATALOG_PRICE_CHANGED, type EventEnvelope } from "@ecom/contracts";

const ev = (type: string, payload: object): EventEnvelope => makeEnvelope({ type, version: 1, traceId: "t", producer: "catalog", payload });
const row = (id: string) => prisma.catalogReadModel.findUnique({ where: { productId: id } });

describe("order catalog projection (integration)", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("product_created inserts; higher-version update applies; lower/equal version no-ops", async () => {
    const id = `p_${randomUUID()}`;
    await handleCatalogEvent(ev(CATALOG_PRODUCT_CREATED, { productId: id, name: "A", price: 100, version: 1 }));
    expect((await row(id))!.price).toBe(100);
    await handleCatalogEvent(ev(CATALOG_PRODUCT_UPDATED, { productId: id, name: "B", price: 200, version: 2 }));
    expect((await row(id))!.price).toBe(200);
    // stale/duplicate (version 1) -> ignored
    await handleCatalogEvent(ev(CATALOG_PRODUCT_UPDATED, { productId: id, name: "OLD", price: 999, version: 1 }));
    const r = await row(id);
    expect(r!.price).toBe(200); expect(r!.version).toBe(2);
  });

  it("out-of-order: update (v2) arrives before create (v1) -> ends at v2, create no-ops", async () => {
    const id = `p_${randomUUID()}`;
    await handleCatalogEvent(ev(CATALOG_PRODUCT_UPDATED, { productId: id, name: "B", price: 200, version: 2 }));
    await handleCatalogEvent(ev(CATALOG_PRODUCT_CREATED, { productId: id, name: "A", price: 100, version: 1 }));
    const r = await row(id);
    expect(r!.price).toBe(200); expect(r!.version).toBe(2);
  });

  it("price_changed is ignored by the read model", async () => {
    const id = `p_${randomUUID()}`;
    await handleCatalogEvent(ev(CATALOG_PRODUCT_CREATED, { productId: id, name: "A", price: 100, version: 1 }));
    await handleCatalogEvent(ev(CATALOG_PRICE_CHANGED, { productId: id, price: 555, version: 2 }));
    expect((await row(id))!.price).toBe(100); // unchanged — price_changed not applied
  });
});
```

- [ ] **Step 3: Implement** — create `services/order/src/catalog-projection.ts`:

```ts
import { createLogger, type Logger } from "@ecom/shared";
import {
  EventEnvelope, CATALOG_PRODUCT_CREATED, CATALOG_PRODUCT_UPDATED,
  ProductCreatedPayloadSchema,
} from "@ecom/contracts";
import { prisma } from "./db";
import { catalogProjectionTx } from "./tx-adapters";

const log: Logger = createLogger("order-catalog-projection");

export async function handleCatalogEvent(env: EventEnvelope): Promise<void> {
  if (env.type !== CATALOG_PRODUCT_CREATED && env.type !== CATALOG_PRODUCT_UPDATED) return; // ignore price_changed + others
  const p = ProductCreatedPayloadSchema.parse(env.payload); // created/updated share the shape
  await prisma.$transaction((tx) => catalogProjectionTx(tx).apply(p));
  log.info("catalog_projected", { productId: p.productId, version: p.version, traceId: env.traceId });
}
```

Append `catalogProjectionTx` to `services/order/src/tx-adapters.ts`:

```ts
export function catalogProjectionTx(tx: Prisma.TransactionClient) {
  return {
    async apply(p: { productId: string; name: string; price: number; version: number }) {
      // Single atomic conditional upsert — idempotent, out-of-order- and concurrency-safe.
      await tx.$executeRaw`
        INSERT INTO "CatalogReadModel" ("productId", name, price, version, "updatedAt")
        VALUES (${p.productId}, ${p.name}, ${p.price}, ${p.version}, now())
        ON CONFLICT ("productId") DO UPDATE
          SET name = EXCLUDED.name, price = EXCLUDED.price,
              version = EXCLUDED.version, "updatedAt" = now()
          WHERE EXCLUDED.version > "CatalogReadModel".version`;
    },
  };
}
```

- [ ] **Step 4: Wire main.ts** — in `services/order/src/main.ts`: import `handleCatalogEvent` from `./catalog-projection`; after the saga consumer, add:

```ts
  const catalogConsumer = createConsumer(kafka, "order-catalog-projection");
  await catalogConsumer.connect();
  await catalogConsumer.run(["catalog.events"], handleCatalogEvent);
```
and add `async () => { await catalogConsumer.disconnect(); },` to the `gracefulShutdown` array (place it just above the saga `consumer.disconnect()` entry so both stop before the server-close entry runs last-in-reverse). Update the teardown comment.

- [ ] **Step 5: Migrate deploy + run int + typecheck.**

Run: `DATABASE_URL='postgresql://ecom:ecom@localhost:5432/order' pnpm --filter @ecom/order exec prisma migrate deploy`
Run: `DATABASE_URL='postgresql://ecom:ecom@localhost:5432/order' pnpm vitest run services/order/src/__tests__/catalog-projection.int.test.ts`
Run: `pnpm --filter @ecom/order typecheck`
Expected: PASS (3), clean.

- [ ] **Step 6: Commit**

```bash
git add services/order/prisma services/order/src/catalog-projection.ts services/order/src/tx-adapters.ts services/order/src/main.ts services/order/src/__tests__/catalog-projection.int.test.ts
git commit -m "feat(order): catalog.events projection (atomic version-guarded upsert)"
```

---

### Task 8: Order — retire `POST /admin/catalog` + migrate seeders

**Files:**
- Modify: `services/order/src/app.ts` (remove route + `AdminCatalogSchema`)
- Modify tests: `services/order/src/__tests__/{order.e2e,order.int,order-payment-leg.e2e,cart.int,inventory-leg.e2e,order-stream.e2e}.test.ts`

- [ ] **Step 1: Remove the route** — in `services/order/src/app.ts` delete the `AdminCatalogSchema` const and the entire `app.post("/admin/catalog", …)` handler. (Leave every other route.)

- [ ] **Step 2: Migrate every seeder.** Find them: `grep -rn "admin/catalog" services/order/src/__tests__`. In each test, replace the seed call

```ts
await request(app).post("/admin/catalog").send({ productId: pid, name: "x", price: total });
```
with a direct read-model insert (the projection is not running in these per-service tests):
```ts
await prisma.catalogReadModel.upsert({
  where: { productId: pid },
  create: { productId: pid, name: "x", price: total, version: 1 },
  update: { name: "x", price: total, version: 1 },
});
```
Import `prisma` from `../db` in any test that doesn't already. Do this for all six files. Keep each test's assertions unchanged — only the seeding mechanism changes.

- [ ] **Step 3: Run the whole Order suite (unit + int + e2e).**

Run: `DATABASE_URL='postgresql://ecom:ecom@localhost:5432/order' pnpm --filter @ecom/order exec prisma migrate deploy`
Run: `DATABASE_URL='postgresql://ecom:ecom@localhost:5432/order' pnpm vitest run services/order`
Run: `pnpm --filter @ecom/order typecheck`
Expected: all green — no `/admin/catalog` references remain (`grep -rn admin/catalog services/order` returns nothing).

- [ ] **Step 4: Commit**

```bash
git add services/order/src/app.ts services/order/src/__tests__/order.e2e.test.ts services/order/src/__tests__/order.int.test.ts services/order/src/__tests__/order-payment-leg.e2e.test.ts services/order/src/__tests__/cart.int.test.ts services/order/src/__tests__/inventory-leg.e2e.test.ts services/order/src/__tests__/order-stream.e2e.test.ts
git commit -m "refactor(order): retire POST /admin/catalog; seed read-model directly in tests"
```

---

### Task 9: Cross-service projection e2e + runbook + regression gate

**Files:**
- Create: `services/order/src/__tests__/catalog-projection.e2e.test.ts`, `docs/runbooks/phase-4-catalog-demo.md`

- [ ] **Step 1: Projection e2e (real Kafka, injected `catalog.events`)** — create `services/order/src/__tests__/catalog-projection.e2e.test.ts`: publish `catalog.product_created`/`product_updated` to `catalog.events` via a real producer, run the Order `handleCatalogEvent` consumer, and assert the read model reflects the latest version; then `place()` an order for that product and assert it prices from the projected value (no admin seed). Reuse the harness from `order-payment-leg.e2e.test.ts` (createKafka/producer/consumer) + its `place()` helper:

```ts
it("projected product prices a real order (no admin seed)", async () => {
  const pid = `p_${randomUUID()}`;
  await producer.publish("catalog.events", makeEnvelope({ type: CATALOG_PRODUCT_CREATED, version: 1, traceId: "t", producer: "catalog", payload: { productId: pid, name: "Widget", price: 750, version: 1 } }));
  await waitFor(async () => (await prisma.catalogReadModel.findUnique({ where: { productId: pid } }))?.price === 750);
  // place() adds pid to cart + posts /orders; the order totals from the projected price
  const orderId = await placeForProduct(pid, 1);
  const order = (await request(app).get(`/orders/${orderId}`)).body;
  expect(order.totalPrice).toBe(750);
}, 30000);
```
> Provide `waitFor` + a `placeForProduct(pid, qty)` helper (cart add + POST /orders using `x-user-id`). The consumer is Order's real `handleCatalogEvent` on a `createConsumer(kafka, "order-catalog-projection-e2e-<ts>")` group.

- [ ] **Step 2: Run the e2e** (inline DATABASE_URL). Expected PASS.

- [ ] **Step 3: Runbook** — create `docs/runbooks/phase-4-catalog-demo.md`:

```md
# Phase 4 — manual demo (Catalog → Order projection)

Prereq: `cp docker-compose.example.yml docker-compose.yml`, per-service `.env`s, images built.

1. `docker compose --profile app up -d`   # + catalog on :3004
2. Create a product in Catalog:
   `curl -X POST localhost:3004/products -d '{"type":"ELECTRONICS","name":"Widget","price":500,"attributes":{"manufacturer":"Acme"}}' -H 'content-type: application/json'`  # -> productId
3. Watch it project into Order: `curl localhost:3002/orders/... ` — or seed a cart + place an order for that productId; the order prices from the **projected** value, no `/admin/catalog`.
4. Update the price: `curl -X PATCH localhost:3004/products/<id> -d '{"price":900}' -H 'content-type: application/json'` → a new order prices at 900.
5. Comments: `curl -X POST localhost:3004/products/<id>/comments -d '{"body":"nice"}' -H 'content-type: application/json'`; `curl localhost:3004/products/<id>/comments`.
6. Discount: `curl -X POST localhost:3004/discounts -d '{"code":"SAVE10","kind":"PERCENT","value":10,"minOrder":100,"maxUses":5,"maxPerUser":1,"expiresAt":"2030-01-01T00:00:00.000Z"}' -H 'content-type: application/json'`; `curl -X POST localhost:3004/discounts/SAVE10/apply -d '{"userId":"u1","orderTotal":1000}' -H 'content-type: application/json'` → `{"amount":100}` (service-local; NOT applied to checkout).
7. `docker compose --profile app down`.

Automated cross-service full-loop → Phase 7.
```

- [ ] **Step 4: Regression gate (per-service DBs) + format + typecheck.**

Run each with its own inline `DATABASE_URL`:
`pnpm vitest run services/catalog` (catalog), `services/order` (order), `services/payment` (payment), `services/inventory` (inventory), `packages/shared` (shared).
Expected green EXCEPT the known pre-existing `services/inventory/src/__tests__/sweeper.int.test.ts` 2 (stale-dev-DB non-regression — confirm sweeper/release unchanged). Anything else failing IS a regression → report, don't weaken.
Run: `pnpm format` then `pnpm format:check`; `pnpm -r typecheck`. Expected clean.

- [ ] **Step 5: Commit**

```bash
git add services/order/src/__tests__/catalog-projection.e2e.test.ts docs/runbooks/phase-4-catalog-demo.md
git commit -m "test(4): cross-service projection e2e + manual catalog demo runbook"
# if format changed files:
git add -u && git commit -m "style: prettier"
```

---

## Self-Review

**Spec coverage:**
- Catalog products + per-type attributes → Tasks 2–3; events → Task 3; contracts → Task 1. Comments → Task 4. Discounts (rules + row-locked apply) → Task 5. Wiring/compose/CI/standalone-e2e → Task 6. Order projection (atomic version-guarded upsert, separate consumer group) → Task 7. Retire `/admin/catalog` + seeder migration → Task 8. Cross-service e2e + runbook + regression gate → Task 9.
- Global constraints: atomic `ON CONFLICT … WHERE` upsert (Task 7); `aggregateType:"product"` + constant `topicFor` (Task 3 core + Task 3d main); version-in-payload (Tasks 3/7); `type` immutable + PATCH validates stored type (Task 3 `applyUpdate`); row-locked discount apply (Task 5); no-auth/ids-only (all routes); migrations-CLI-only (Tasks 2/7); per-service regression (Task 9).

**Placeholder scan:** none — every step has code/commands/expected output. "Clone payment's X" instructions name the exact sibling file to copy (config/db/outbox-adapter/Dockerfile/main harness) — a concrete template, not a placeholder. The Task-6/9 e2e "reuse the harness from payment.e2e/order-payment-leg.e2e" name specific files + show the added assertions + the helpers to provide.

**Type consistency:** `ProductWriteTx`/`applyCreate`/`applyUpdate` (Task 3) ↔ `productTx` (Task 3) ↔ routes (Task 3); `validateAttributes` (Task 2) ↔ `applyCreate/Update` (Task 3); `getDiscountAmount`/`DiscountRule`/`DiscountCtx` (Task 5) ↔ apply route (Task 5); `catalog` contracts (Task 1) ↔ catalog emit (Task 3) ↔ order projection (Task 7); `catalogProjectionTx.apply({productId,name,price,version})` (Task 7) ↔ `handleCatalogEvent` (Task 7); `assembleTree`/`CommentNode` (Task 4). `CatalogReadModel.version` (Task 7) used by the atomic upsert (Task 7) + the direct-insert seeders (Task 8, `version:1`).

**Infra:** Tasks 1 offline; 2–9 need Postgres (`catalog`/`order` DBs); Tasks 6/9 e2e need Kafka. CI's integration job has them. `.env` gitignored → inline `DATABASE_URL` per service throughout.
