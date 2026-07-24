# Phase 4 · Catalog (products + projection + comments + discounts) — Design (child spec)

> Combined Phase-4 spec (user decision — 4a + 4b + 4c in one cycle/PR). New
> `services/catalog` owns products/comments/discounts and emits `catalog.events`;
> Order gains a version-guarded projection that replaces its 2a `POST /admin/catalog`
> price stand-in. Reference: `docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md`
> (Phase 4). Two services touched (Catalog new; Order projection).

## Purpose

1. **Catalog service (4a):** products as one table + per-type zod-validated JSONB
   attributes (collapse the legacy Electronics/Clothing/Furniture/Motorbike factory),
   CRUD admin HTTP, outbox → Kafka `catalog.events`
   (`product_created`/`product_updated`/`price_changed`).
2. **Order projection (4b):** consume `catalog.events` → **version-guarded** idempotent
   upsert into `catalog_read_model`; retire Order's `POST /admin/catalog`;
   replay-from-earliest bootstrap.
3. **Comments + discounts (4c, catalog-local):** re-derived comment tree (adjacency
   list); discount CRUD + `getDiscountAmount` rules + redemption tracking. Neither is
   wired into checkout.

## Scope

**In scope**
- `services/catalog`: `Product` (+ per-type attribute validation), `Comment`,
  `Discount`, `DiscountRedemption`, `Outbox`, admin HTTP, outbox relay → `catalog.events`.
- `packages/contracts`: `catalog.ts` event schemas.
- Order: `CatalogReadModel.version`; a **separate** catalog-projection consumer group;
  **removal** of `POST /admin/catalog` + `AdminCatalogSchema`; test migration.
- Compose `catalog` app entry + CI step (the `catalog` Postgres DB **already exists** in
  `infra/postgres/init/01-databases.sql` — no init change).

**Out of scope** (explicit)
- **Discounts in checkout pricing** — locked. Order prices from its local
  `catalog_read_model` only; `getDiscountAmount` is exercised service-locally, never by
  Order. "Discount projection into Order" is a named backlog item.
- **Auth on any Catalog endpoint** — admin CRUD, comments, discount-apply are all
  unauthenticated (Phase 6 gateway), consistent with the other services' admin surfaces.
- **Media upload, search/Elasticsearch, comment moderation.**
- **Attributes in contracts / typed for consumers** — attributes are opaque JSONB in
  events; only `{productId, name, price, version}` is contract-typed (Q2).
- **Comment/discount events** — comments and discounts are catalog-local; they emit
  nothing on `catalog.events`.

## Catalog products (4a) — `services/catalog`

Service structure mirrors `services/payment`/`inventory`: Express + Prisma (own `catalog`
DB) + `traceMiddleware` + `createHealthRouter` + outbox relay + `gracefulShutdown` +
`createLogger`. Config `PORT=3004`, `DATABASE_URL`, `KAFKA_BROKERS`, `LOG_LEVEL`.

### Data model (`services/catalog/prisma/schema.prisma`)

```prisma
model Product {
  id         String   @id @default(uuid())
  type       String                          // ELECTRONICS | CLOTHING | FURNITURE | MOTORBIKE
  name       String
  price      Int                             // integer minor units
  version    Int      @default(1)            // bumps on EVERY mutation; the projection guard
  attributes Json                            // per-type shape, validated app-side (not in DB)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
}
```
Plus `Comment`, `Discount`, `DiscountRedemption` (below) and the standard `Outbox` +
`ProcessedEvent` models copied from a sibling service's schema.

### Per-type attributes (`services/catalog/src/attributes.ts`)

Catalog-local zod map keyed by `type`, derived from the legacy factory
(`legacy/src/models/product.model.js` + `legacy/src/configs/product.config.js` — read
them to reproduce each type's fields):

```ts
export const ATTRIBUTE_SCHEMAS = {
  ELECTRONICS: z.object({ manufacturer: z.string().min(1), model: z.string().min(1), warrantyMonths: z.number().int().nonnegative() }),
  CLOTHING:    z.object({ brand: z.string().min(1), size: z.string().min(1), material: z.string().min(1) }),
  FURNITURE:   z.object({ brand: z.string().min(1), material: z.string().min(1), dimensions: z.string().min(1) }),
  MOTORBIKE:   z.object({ brand: z.string().min(1), engineCc: z.number().int().positive(), color: z.string().min(1) }),
} as const;
export type ProductType = keyof typeof ATTRIBUTE_SCHEMAS;
export function validateAttributes(type: string, attrs: unknown): { ok: true; value: unknown } | { ok: false };
```
> The exact per-type fields must be transcribed from the legacy config, not invented —
> **golden tests** assert a legacy sample of each type validates. If a legacy field has
> no clean mapping, document the decision in the spec's Design-decisions before coding.

### Admin HTTP + events (`services/catalog/src/app.ts`, cores in `product.ts` + `tx-adapters.ts`)

- `POST /products` `{type, name, price, attributes}` → validate type + attributes (400
  on invalid) → in one `prisma.$transaction`: create `Product` (version 1) + outbox
  `product_created` `{productId, name, price, version:1}`. 201.
- `PATCH /products/:id` `{name?, price?, attributes?}` → 404 if absent → **load the stored
  `type` first**; if `attributes` is present, validate it against the stored type's schema
  (400 on invalid) — `type` itself is immutable this pass. In one tx: bump `version`
  (`{ increment: 1 }`), apply the fields, outbox `product_updated`
  `{productId, name, price, version}`; **if `price` changed**, ALSO outbox `price_changed`
  `{productId, price, version}`. 200.
- `GET /products/:id` (404 if absent), `GET /products` (list). Read-only, no events.

The domain core `applyProductWrite(tx, …)` returns the new `{version, priceChanged}` so
the route/tx-adapter enqueues the right events; the outbox row(s) commit **in the same
tx** as the write (transactional outbox, same as every other service). Outbox rows:
`aggregateType: "product"` (honest — the aggregate is the product), `aggregateId:
productId`, `producer: "catalog"`. Catalog starts its relay with a **constant
`topicFor: () => "catalog.events"`** (the topic is a service concern, decoupled from the
aggregate name) so every catalog row lands on `catalog.events`.

## Contracts (4a) — `packages/contracts/src/events/catalog.ts`

```ts
export const CATALOG_PRODUCT_CREATED = "catalog.product_created" as const;
export const CATALOG_PRODUCT_UPDATED = "catalog.product_updated" as const;
export const CATALOG_PRICE_CHANGED   = "catalog.price_changed" as const;

const ProductUpsertPayload = z.object({
  productId: z.string().min(1), name: z.string().min(1),
  price: z.number().int().positive(), version: z.number().int().positive(),
});
export const ProductCreatedPayloadSchema = ProductUpsertPayload;
export const ProductUpdatedPayloadSchema = ProductUpsertPayload;
export const PriceChangedPayloadSchema = z.object({
  productId: z.string().min(1), price: z.number().int().positive(), version: z.number().int().positive(),
});
```
Add `export * from "./events/catalog"` to `packages/contracts/src/index.ts`. Attributes
are intentionally absent (opaque/catalog-local).

## Order projection (4b) — `services/order`

### Schema

`CatalogReadModel` gains `version Int @default(0)` (existing rows default 0 so any real
event, version ≥ 1, applies). Migration via CLI.

### Projection consumer (`services/order/src/catalog-projection.ts`, new)

- A **separate consumer group** `order-catalog-projection` (NOT the saga
  `order-consumers` group) on topic `catalog.events`. The shared `createConsumer`
  subscribes `fromBeginning: true`, so a fresh group **replays `catalog.events` from
  earliest** on first start — the bootstrap. Wired in `main.ts` beside the saga consumer.
- Dispatch: `product_created` and `product_updated` → **version-guarded conditional
  upsert**; `price_changed` → ignored (additive for future consumers). Unknown type → no-op.
- **Version-guarded atomic upsert** (`catalogProjectionTx`), idempotent + out-of-order +
  **concurrency** safe, **no `ProcessedEvent` needed** (the version guard IS the dedup).
  `catalog.events` are keyed by `eventId` (`packages/shared/src/kafka.ts:25`), so a
  product's events may span partitions / consumer instances — a two-step
  updateMany-then-create would have a create-side TOCTOU (two events for a new product
  could each insert, dropping a version). Use **one atomic conditional upsert** instead:
  ```
  await tx.$executeRaw`
    INSERT INTO "CatalogReadModel" ("productId", name, price, version, "updatedAt")
    VALUES (${productId}, ${name}, ${price}, ${version}, now())
    ON CONFLICT ("productId") DO UPDATE
      SET name = EXCLUDED.name, price = EXCLUDED.price,
          version = EXCLUDED.version, "updatedAt" = now()
      WHERE EXCLUDED.version > "CatalogReadModel".version`;
  ```
  Bound-param tagged `$executeRaw` (never `$executeRawUnsafe`). A stale/duplicate event's
  UPDATE is filtered by the `WHERE EXCLUDED.version > …`; a concurrent first insert is
  resolved by `ON CONFLICT`. No dependency on per-product serial processing.

### Retire the admin seed

Delete `POST /admin/catalog` + `AdminCatalogSchema` from `services/order/src/app.ts`.
`place-order.ts`'s `priceOf` (reads `catalog_read_model`) is unchanged — the local-pricing
invariant holds. **Test migration (required):** every test that seeded a price via
`POST /admin/catalog` moves to a direct `prisma.catalogReadModel.create/upsert`
(unit/int) or, in a cross-service e2e, seeds via Catalog + waits for the projection.
Affected (grep `admin/catalog` under `services/order`): the 2b checkout int/e2e,
`order-payment-leg.e2e.test.ts`, `order-stream.e2e.test.ts` — enumerate and migrate all
in the implementation.

## Comments (4c, catalog-local) — `services/catalog`

```prisma
model Comment {
  id        String   @id @default(uuid())
  productId String
  parentId  String?                         // null = root; adjacency list
  body      String
  createdAt DateTime @default(now())
  parent    Comment? @relation("thread", fields: [parentId], references: [id], onDelete: Cascade)
  children  Comment[] @relation("thread")
}
```
- `POST /products/:id/comments` `{body, parentId?}` → 400 if `parentId` is not an existing
  comment on this product; create. `GET /products/:id/comments` → the threaded tree built
  from a **flat `findMany({ where: { productId }, orderBy: { createdAt: "asc" } })` +
  app-side assembly** into parent/child (the `productId` filter already fetches every node
  of the product's forest — no recursion, no raw SQL needed for a whole-product thread).
  `DELETE /comments/:id` → subtree removed via the `onDelete: Cascade` self-relation.
- **Property tests** on insert/delete: a deleted node removes exactly its subtree;
  building the tree from a random insert sequence yields correct parent/child links.
- No events.

## Discounts (4c, catalog-local, NOT in checkout) — `services/catalog`

```prisma
model Discount {
  id         String   @id @default(uuid())
  code       String   @unique
  kind       String                          // PERCENT | FIXED
  value      Int                             // percent (0-100) or fixed minor units
  minOrder   Int      @default(0)
  maxUses    Int                             // total redemptions allowed
  maxPerUser Int                             // per-user redemptions allowed
  expiresAt  DateTime
  createdAt  DateTime @default(now())
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
```
- **Pure core** `getDiscountAmount(discount, { userId, orderTotal, totalUses, userUses })`
  → checks `now < expiresAt`, `orderTotal >= minOrder`, `totalUses < maxUses`,
  `userUses < maxPerUser`; returns `{ amount }` (PERCENT: `floor(orderTotal*value/100)`,
  FIXED: `min(value, orderTotal)`) or `{ ineligible: reason }`. Amount capped at
  `orderTotal`. Counts are passed in (the tx supplies them) so the core is pure/unit-testable.
- `POST /discounts` (create), `GET /discounts/:code`.
- `POST /discounts/:code/apply` `{userId, orderTotal}` → in one `prisma.$transaction`
  that **locks the discount row** (`SELECT ... FOR UPDATE` via `$queryRaw`, or a
  serializable tx) → re-count total + per-user redemptions → `getDiscountAmount` → if
  eligible, insert a `DiscountRedemption` and return `{amount}`; else 409 `{reason}`. The
  row lock serializes concurrent applies for the same code so `maxUses`/`maxPerUser`
  cannot be exceeded (count-then-insert without the lock is a TOCTOU — the same
  concurrent-HTTP hazard the 3c webhook/refund resolved with compare-and-set).
- Service-local only; no event, no Order involvement.

## Wiring & infra

- **Catalog `main.ts`:** producer + outbox relay (`startOutboxRelay(outboxPort, producer,
  (t)=>`${t}.events`)` → `catalog.events` via `aggregateType:"catalog"`), app.listen(3004),
  `gracefulShutdown([prisma, producer, server])`. No Rabbit (Catalog emits events only).
- **Order `main.ts`:** add a second consumer
  `createConsumer(kafka, "order-catalog-projection")` → `run(["catalog.events"],
  handleCatalogEvent)`; add its `disconnect()` to `gracefulShutdown` (before
  `prisma.$disconnect`, alongside the saga consumer).
- **Compose:** a `catalog` app-profile service (Dockerfile, `DATABASE_URL=…/catalog`,
  `KAFKA_BROKERS`, `PORT 3004`, depends_on postgres+kafka healthy, `/readyz` healthcheck).
  Postgres `catalog` DB already provisioned. **`.github/workflows/ci.yml`:** a Catalog
  integration step (env: DATABASE_URL catalog, KAFKA_BROKERS).
- **Dockerfile:** `services/catalog/Dockerfile` copied from a sibling.

## Configuration & inherited Definition of Done

- Money integer minor units. Logging **ids-only** (`productId`, `discountCode`?, `userId`,
  `version`, `traceId` — never full product bodies/attributes as they may grow, never
  discount internals beyond the code). Prisma convention PascalCase/camelCase/no `@map`.
  Migrations CLI-only. Per-service `.env` gitignored (host-test gap: inline `DATABASE_URL`).

## Design decisions (resolved)

- **Combined 4a+4b+4c in one spec/PR** (user).
- **Per-type attributes = catalog-local zod, opaque JSONB in events** (Q2); schemas
  transcribed from the legacy factory, golden-tested.
- **Ordering guard = per-product integer `version`** on every event; the projection
  applies via a **single atomic `ON CONFLICT … WHERE EXCLUDED.version > version` upsert**
  driven by `product_created`/`product_updated`; `price_changed` additive (Q3).
- **Bootstrap = replay-from-earliest** (native `fromBeginning:true` on a fresh
  `order-catalog-projection` group); `POST /admin/catalog` **removed** (Q4).
- **Comments = adjacency list**, whole-product thread read via flat `findMany` + app-side
  assembly (no recursion needed) (Q5).
- **Discounts = full rules + redemption tracking, service-local, row-locked apply**, NOT
  in checkout (Q6).
- **Event routing = `aggregateType:"product"` + constant `topicFor: () => "catalog.events"`**
  (honest aggregate name; topic decoupled from it).
- **Projection needs no `ProcessedEvent`** — the atomic version-guarded upsert is
  idempotent, out-of-order- AND concurrency-safe on its own.
- **Discount apply is row-locked** (`FOR UPDATE`) to prevent over-redemption under
  concurrent HTTP (the 3c CAS lesson, applied to a count-then-insert).

## Known limitations (intentional)

1. No auth on Catalog admin/comments/discount endpoints (Phase 6 gateway).
2. `type` is immutable after create (a type change would invalidate attributes) — a
   product is deleted+recreated to change type; no DELETE product this pass (not needed).
3. Discounts never affect checkout (locked); `getDiscountAmount` is a service-local demo.
4. Comment tree read is unbounded depth — fine for the demo; pagination/depth-limit later.
5. `catalog.events` grows unbounded; a fresh projection group replays all of it
   (bootstrap desired, but the Phase-7 topic-retention/e2e-reset note applies here too).

## Testing (TDD)

- **Catalog unit:** `validateAttributes` **golden tests** (a legacy sample of each of the
  4 types validates; a wrong-shape sample rejects); `applyProductWrite` (version bump,
  price-changed detection → which events); `getDiscountAmount` pure rules (expiry,
  minOrder, maxUses, maxPerUser, PERCENT/FIXED, cap); comment-tree assembly.
- **Catalog int (needs Postgres):** `POST/PATCH /products` → correct outbox rows
  (`product_created`; `product_updated` + `price_changed` on price change; no
  `price_changed` on a name-only change); `POST /discounts/:code/apply` idempotency +
  **concurrency** (N parallel applies never exceed `maxUses`/`maxPerUser` — the row-lock
  test); comment insert/delete + recursive read.
- **Order projection int (needs Postgres):** version-guarded upsert applies a newer
  version, **no-ops** an older/duplicate version and an out-of-order create-after-update;
  a fresh consumer replays existing `catalog.events` into the read model.
- **Migration:** all former `POST /admin/catalog` seeders migrated + green.
- **e2e (per-leg + manual):** Catalog standalone (create/update → `catalog.events`);
  Order projection leg (inject `catalog.events` → read model). Full cross-service (Catalog
  create → Order read model → place order prices from it, no admin seed) = **manual demo
  runbook** `docs/runbooks/phase-4-catalog-demo.md` (automated cross-service → Phase 7).
- **Regression gate:** `services/catalog services/order services/payment services/inventory
  packages/shared` (per-service DBs; the known 3a-sweeper caveat noted).

## Definition of Done

- Create/update a product in Catalog → it appears in Order's `catalog_read_model` with
  the correct price and monotonic version → a new order prices from it with **no admin
  seed** involved; an out-of-order/duplicate `catalog.events` never corrupts the price.
- `POST /discounts/:code/apply` enforces all four rules and cannot over-redeem under
  concurrent requests; comments thread/untree correctly.
- `POST /admin/catalog` is gone; all migrated tests green; Catalog + Order + Payment +
  Inventory + shared suites green; typecheck + format clean; ids-only logging.

## Open questions

1. **Attribute field set per type** — transcribed from the legacy config; if the legacy
   fields are messy, the plan documents the chosen mapping (golden tests pin it).
2. **Discount `apply` lock mechanism** — `SELECT … FOR UPDATE` on the discount row vs a
   serializable tx; the plan picks one (FOR UPDATE preferred, narrower).
