# Phase 8a — Storefront foundation + catalogue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `apps/web` — a Vite + React storefront in the pnpm workspace — rendering
Catalog's product list and detail through the gateway, with every response validated at the
boundary against schemas that Catalog itself is tested against.

**Architecture:** The app joins the existing workspace and imports `@ecom/contracts` as
TypeScript source, exactly as the eight services do. The browser never addresses the gateway
directly: Vite's dev server proxies the API prefixes, so there is no CORS and no gateway URL
in the bundle. One `request()` helper owns fetch, status mapping and zod parsing, and is the
only code that knows HTTP exists. Design tokens are declared once in a Tailwind v4 `@theme`
block lifted from the approved prototype.

**Tech Stack:** React 19.2, Vite 8.2, Tailwind CSS 4.3 (CSS-first, `@tailwindcss/vite`),
React Router 8.3, TanStack Query 5.101, Vitest 2.1 (the repo's existing pin) + Testing
Library 16.3 + jsdom 30, TypeScript 5.7 (the repo's existing pin), zod 3 via
`@ecom/contracts`.

Spec: `docs/superpowers/specs/2026-07-30-phase-8a-storefront-foundation-design.md`.

## Global Constraints

Every task's requirements implicitly include this section.

1. **Base branch must contain Phase 7d.** Per the spec's §Preconditions, start from `main`
   once PR #7 merges (preferred), or from 7d's head. Do **not** implement on a base without
   it: 7d added the `infra/**` glob to `vitest.config.ts` and a `k6/**` block to
   `eslint.config.js`, and both files are edited here.
2. **`vitest.workspace.ts` must carry an `infra` project**, alongside `packages`, `services`
   and the new `apps/web`. Dropping it re-creates the uncovered-suite gap 7d closed.
3. **Vitest stays at the repo's `^2.1.0` and TypeScript at `^5.7.0`.** Vitest 4 removed
   `vitest.workspace.ts` and TypeScript 7 is a rewrite; upgrading either would touch every
   service's tests and is out of scope for a frontend slice.
4. **No production code in any of the eight services changes.** The only service file touched
   is a new Catalog *test* file (Task 2).
5. **Exact pinned versions** (resolved 2026-07-30 — the spec requires pinning rather than
   trusting peer-support claims):
   `react@19.2.8`, `react-dom@19.2.8`, `vite@8.2.0`, `@vitejs/plugin-react@6.0.5`,
   `tailwindcss@4.3.3`, `@tailwindcss/vite@4.3.3`, `react-router@8.3.0`,
   `@tanstack/react-query@5.101.4`, `jsdom@30.0.1`, `@testing-library/react@16.3.2`,
   `@testing-library/jest-dom@7.0.0`.
6. **Tailwind v4 is CSS-first.** Tokens live in an `@theme` block in CSS. There is no
   `tailwind.config.js` and no `content` array — do not create one.
7. **No hard-coded colour, radius or shadow literal in any component.** Every one comes from
   a token (spec §H).
8. **No API-sourced value is ever passed to `dangerouslySetInnerHTML`** (spec §C3).
9. **`price` is integer minor units.** Divide by 100 at the presentation layer only.
10. **The browser only ever calls same-origin paths.** No absolute gateway URL in any
    component, and no CORS middleware is added to the gateway.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `apps/web/package.json` | Workspace member; scripts `dev`/`build`/`typecheck`/`lint` |
| `apps/web/index.html` | Vite entry document |
| `apps/web/vite.config.ts` | React + Tailwind plugins, dev proxy for API prefixes |
| `apps/web/tsconfig.json` | Extends the repo base; DOM libs, JSX |
| `apps/web/vitest.setup.ts` | Registers `@testing-library/jest-dom` |
| `apps/web/src/main.tsx` | Mounts React, QueryClientProvider, RouterProvider |
| `apps/web/src/styles.css` | `@import "tailwindcss"` + the `@theme` token block |
| `apps/web/src/api/errors.ts` | `NetworkError`, `HttpError`, `SchemaMismatchError` |
| `apps/web/src/api/request.ts` | fetch → status mapping → zod parse. Only HTTP-aware module |
| `apps/web/src/api/products.ts` | `listProducts()`, `getProduct(id)` |
| `apps/web/src/api/queryClient.ts` | Retry policy pinned to network-only |
| `apps/web/src/components/*.tsx` | `Card`, `Badge`, `Price`, `Skeleton`, `EmptyState`, `ErrorState`, `Button`, `Silhouette` |
| `apps/web/src/routes/Home.tsx` | Hero, category chips, product grid, 3 async states |
| `apps/web/src/routes/Product.tsx` | Detail, attributes table, 404 case |
| `packages/contracts/src/http/catalog.ts` | `ProductListItem`, `ProductDetail` schemas |
| `services/catalog/src/__tests__/product-contract.int.test.ts` | Catalog asserts its own responses satisfy the shared schemas |
| `vitest.workspace.ts` | Four projects; existing three unchanged |

**Modified**

| File | Change |
|---|---|
| `pnpm-workspace.yaml` | Add `apps/*` |
| `eslint.config.js` | Add an `apps/web/**` block (JSX + react-hooks) |
| `packages/contracts/src/index.ts` | Export the new HTTP schemas |
| `docs/superpowers/specs/2026-07-18-microservices-streaming-rebuild-design.md` | Two DoD amendments (Task 7) |
| `docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md` | 8a line amendment (Task 7) |

---

### Task 1: Workspace member, vitest project, lint block

Scaffolding, config and the test wiring all serve one deliverable — an `apps/web` that the
repo's existing recursive scripts pick up — so they are one task.

**Files:**
- Create: `apps/web/package.json`, `apps/web/index.html`, `apps/web/vite.config.ts`,
  `apps/web/tsconfig.json`, `apps/web/vitest.setup.ts`, `apps/web/src/main.tsx`,
  `apps/web/src/App.tsx`, `apps/web/src/styles.css`
- Create: `vitest.workspace.ts`
- Create: `apps/web/src/__tests__/smoke.test.tsx`
- Modify: `pnpm-workspace.yaml`, `eslint.config.js`

**Interfaces:**
- Produces: the `@ecom/web` workspace package; a `apps/web` vitest project running in jsdom.

- [ ] **Step 1: Add `apps/*` to the workspace**

In `pnpm-workspace.yaml`, add `- "apps/*"` under the existing `packages:` list, keeping the
`onlyBuiltDependencies` block untouched:

```yaml
packages:
  - "packages/*"
  - "services/*"
  - "apps/*"
```

- [ ] **Step 2: Create the package manifest**

`apps/web/package.json`:

```json
{
  "name": "@ecom/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json --noEmit && vite build",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "preview": "vite preview"
  },
  "dependencies": {
    "@ecom/contracts": "workspace:*",
    "@tanstack/react-query": "5.101.4",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "react-router": "8.3.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "4.3.3",
    "@testing-library/jest-dom": "7.0.0",
    "@testing-library/react": "16.3.2",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "6.0.5",
    "jsdom": "30.0.1",
    "tailwindcss": "4.3.3",
    "vite": "8.2.0"
  }
}
```

Note there is no `vitest` dependency here — the root's `^2.1.0` runs every project.

- [ ] **Step 3: Create tsconfig**

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "bundler",
    // `globals: true` in vite.config.ts means vi/it/expect are ambient — without
    // "vitest/globals" here every test file fails `pnpm typecheck` on unresolved names.
    "types": ["vite/client", "vitest/globals"]
  },
  "include": ["src", "vite.config.ts", "vitest.setup.ts"]
}
```

`module`/`moduleResolution` are overridden because the repo base targets CommonJS for Node
services; Vite needs ESM + bundler resolution.

- [ ] **Step 4: Create the Vite config with the dev proxy**

`apps/web/vite.config.ts`. The proxy is what makes the browser same-origin (spec §C1):

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The browser never addresses the gateway directly. Every API prefix is proxied so the app
// is same-origin: no CORS on the gateway, and 8b's cookies work on SameSite=Lax.
const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:8000";
const API_PREFIXES = ["/products", "/cart", "/orders", "/auth"];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: Object.fromEntries(
      API_PREFIXES.map((p) => [p, { target: GATEWAY, changeOrigin: true }])
    ),
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
```

- [ ] **Step 5: Create the vitest setup file**

`apps/web/vitest.setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 6: Create the workspace test config**

`vitest.workspace.ts` at the repo root. **Global Constraint 2**: the `infra` project must be
here.

```ts
// One `pnpm vitest run` covers every project. The three node projects keep the globs and
// timeouts the root config already used; apps/web needs jsdom, which the node projects must
// not inherit — which is the whole reason this file exists.
import { defineWorkspace } from "vitest/config";

const node = {
  testTimeout: 20_000,
  hookTimeout: 30_000,
};

export default defineWorkspace([
  { test: { ...node, name: "packages", include: ["packages/**/*.test.ts"] } },
  { test: { ...node, name: "services", include: ["services/**/*.test.ts"] } },
  { test: { ...node, name: "infra", include: ["infra/**/*.test.ts"] } },
  "./apps/web",
]);
```

- [ ] **Step 7: Delete the superseded root config**

Remove `vitest.config.ts`. Its three globs and both timeouts are carried above; leaving both
files means vitest picks the workspace file and the stale one silently rots.

```bash
git rm vitest.config.ts
```

- [ ] **Step 8: Add the eslint block**

In `eslint.config.js`, append a block after the existing `k6/**/*.js` block, before the
closing `)`:

```js
  {
    // The storefront runs in a browser with JSX, neither of which the service configs cover.
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { window: "readonly", document: "readonly", fetch: "readonly" },
    },
  }
```

- [ ] **Step 9: Create the minimal app**

`apps/web/src/styles.css`:

```css
@import "tailwindcss";
```

`apps/web/src/App.tsx`:

```tsx
export function App() {
  return <h1>Storefront</h1>;
}
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Storefront</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 10: Write the failing smoke test**

`apps/web/src/__tests__/smoke.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { App } from "../App";

it("renders the app shell", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "Storefront" })).toBeInTheDocument();
});
```

- [ ] **Step 11: Install and run — verify the new project is picked up**

```bash
pnpm install
pnpm vitest run
```

Expected: four projects run. The `apps/web` project reports 1 passed. **If `apps/web` does
not appear in the output, the workspace file is wrong — stop and fix it**, because a silently
skipped project is exactly the failure this file exists to prevent.

- [ ] **Step 12: Verify the recursive root scripts pick the app up**

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm -r build
```

Expected: all green, and `pnpm -r build` produces `apps/web/dist`.

- [ ] **Step 13: Prove the contracts import resolves through Vite**

This is the spec §A1 residual risk — verify it now, before any feature depends on it. Add to
`apps/web/src/App.tsx` temporarily:

```tsx
import { ORDER_PLACED } from "@ecom/contracts";
export function App() {
  return <h1>Storefront {ORDER_PLACED}</h1>;
}
```

Run `pnpm --filter @ecom/web build`. Expected: builds clean. If Vite fails to resolve or
transform the TypeScript source, add to `vite.config.ts`:
`optimizeDeps: { exclude: ["@ecom/contracts"] }`, and record it as a deviation. Then revert
`App.tsx` to the version in Step 9 and re-run the smoke test.

- [ ] **Step 14: Commit**

```bash
git add pnpm-workspace.yaml eslint.config.js vitest.workspace.ts apps/web
git rm --cached vitest.config.ts 2>/dev/null || true
git commit -m "feat(web): apps/web joins the workspace with its own vitest project"
```

---

### Task 2: Read DTOs in contracts, pinned from both ends

**Files:**
- Create: `packages/contracts/src/http/catalog.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `services/catalog/src/__tests__/product-contract.int.test.ts`

**Interfaces:**
- Produces: `ProductListItemSchema`, `ProductDetailSchema`, and the inferred types
  `ProductListItem`, `ProductDetail`, exported from `@ecom/contracts`.

- [ ] **Step 1: Write the failing contract test**

A new file rather than edits to `product.int.test.ts`, because contract conformance is a
different concern from CRUD behaviour. It follows the repo's fixture-cleanup convention
(tag what you seed, delete it by DB query in `afterAll`).

`services/catalog/src/__tests__/product-contract.int.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../db";
import { ProductListItemSchema, ProductDetailSchema } from "@ecom/contracts";

const app = createApp();

// Catalog asserting its OWN responses against the shared schemas is what makes the storefront
// safe. A client that only validates on its side discovers drift at runtime, in a browser, as
// a blank grid. Here, drift fails a backend test next to the change that caused it.
const TEST_TAG = "test-catalog-contract-int";

describe("catalog read API satisfies the shared contracts", () => {
  afterAll(async () => {
    const seeded = await prisma.product.findMany({
      where: { name: { startsWith: TEST_TAG } },
      select: { id: true },
    });
    const ids = seeded.map((p) => p.id);
    if (ids.length > 0) {
      await prisma.outbox.deleteMany({ where: { aggregateId: { in: ids } } });
      await prisma.product.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.$disconnect();
  });

  it("GET /products items satisfy ProductListItemSchema", async () => {
    await request(app)
      .post("/products")
      .send({
        type: "ELECTRONICS",
        name: `${TEST_TAG}-list`,
        price: 900,
        attributes: { manufacturer: "Acme" },
      })
      .expect(201);

    const res = await request(app).get("/products").expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const item of res.body) {
      const parsed = ProductListItemSchema.safeParse(item);
      if (!parsed.success) throw new Error(`list item drifted: ${parsed.error.message}`);
    }
  });

  it("GET /products/:id satisfies ProductDetailSchema, including attributes", async () => {
    const created = await request(app)
      .post("/products")
      .send({
        type: "CLOTHING",
        name: `${TEST_TAG}-detail`,
        price: 2450,
        attributes: { brand: "Acme", size: "M", material: "cotton", color: "blue" },
      })
      .expect(201);

    const res = await request(app).get(`/products/${created.body.productId}`).expect(200);
    const parsed = ProductDetailSchema.safeParse(res.body);
    if (!parsed.success) throw new Error(`detail drifted: ${parsed.error.message}`);
    expect(parsed.data.attributes).toMatchObject({ brand: "Acme" });
    expect(parsed.data.price).toBe(2450);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `DATABASE_URL=postgresql://ecom:ecom@localhost:5432/catalog pnpm vitest run services/catalog/src/__tests__/product-contract.int.test.ts`
Expected: FAIL — `ProductListItemSchema` is not exported from `@ecom/contracts`.

- [ ] **Step 3: Write the schemas**

`packages/contracts/src/http/catalog.ts`:

```ts
import { z } from "zod";

// The READ API the storefront consumes, distinct from the event payloads in ../events/catalog.
// Two schemas because the two routes genuinely differ: the list omits `attributes`. Modelling
// that as one schema with an optional field would let a detail view silently render nothing
// when the field goes missing.
export const ProductTypeSchema = z.enum([
  "ELECTRONICS",
  "CLOTHING",
  "FURNITURE",
  "MOTORBIKE",
]);
export type ProductType = z.infer<typeof ProductTypeSchema>;

export const ProductListItemSchema = z.object({
  id: z.string(),
  type: ProductTypeSchema,
  name: z.string(),
  // Integer MINOR UNITS. 900 is $9.00. Divide by 100 at the presentation layer only.
  price: z.number().int(),
  version: z.number().int(),
});
export type ProductListItem = z.infer<typeof ProductListItemSchema>;

// `attributes` stays an open record: Catalog owns per-type attribute validation
// (services/catalog/src/attributes.ts), and restating it here would create a second source of
// truth to keep in sync — the exact drift these schemas exist to prevent.
export const ProductDetailSchema = ProductListItemSchema.extend({
  attributes: z.record(z.unknown()),
});
export type ProductDetail = z.infer<typeof ProductDetailSchema>;
```

- [ ] **Step 4: Export them**

Add to `packages/contracts/src/index.ts`:

```ts
export * from "./http/catalog";
```

- [ ] **Step 5: Run and confirm green**

Run: `DATABASE_URL=postgresql://ecom:ecom@localhost:5432/catalog pnpm vitest run services/catalog/src/__tests__/product-contract.int.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Prove the test discriminates**

The whole value is that drift fails here. Temporarily change `price` in
`ProductListItemSchema` to `z.string()`, re-run, and confirm **both** tests fail with a
message naming `price`. Restore byte-identical and re-run to confirm green.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm typecheck
git add packages/contracts/src/http/catalog.ts packages/contracts/src/index.ts services/catalog/src/__tests__/product-contract.int.test.ts
git commit -m "feat(contracts): catalogue read DTOs, asserted by Catalog itself"
```

---

### Task 3: The gateway client

**Files:**
- Create: `apps/web/src/api/errors.ts`, `apps/web/src/api/request.ts`,
  `apps/web/src/api/products.ts`, `apps/web/src/api/queryClient.ts`
- Create: `apps/web/src/api/__tests__/request.test.ts`

**Interfaces:**
- Consumes: `ProductListItemSchema`, `ProductDetailSchema` from Task 2.
- Produces: `request<T>(path, schema)`, `listProducts()`, `getProduct(id)`,
  `NetworkError`, `HttpError` (with `.status`), `SchemaMismatchError`, `makeQueryClient()`.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/api/__tests__/request.test.ts`:

```tsx
import { z } from "zod";
import { request } from "../request";
import { HttpError, NetworkError, SchemaMismatchError } from "../errors";

const schema = z.object({ id: z.string() });

function mockFetch(impl: () => Promise<Response> | never) {
  vi.stubGlobal("fetch", vi.fn(impl));
}
afterEach(() => vi.unstubAllGlobals());

it("returns parsed data on a valid response", async () => {
  mockFetch(async () => new Response(JSON.stringify({ id: "p1" }), { status: 200 }));
  await expect(request("/products", schema)).resolves.toEqual({ id: "p1" });
});

it("throws HttpError carrying the status on a non-2xx", async () => {
  mockFetch(async () => new Response("nope", { status: 404 }));
  const err = await request("/products", schema).catch((e) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(404);
});

it("throws NetworkError when fetch itself rejects", async () => {
  mockFetch(() => Promise.reject(new TypeError("failed to fetch")));
  await expect(request("/products", schema)).rejects.toBeInstanceOf(NetworkError);
});

// The drift alarm. A shape mismatch is a BUG, not a user-facing condition, so it must be
// distinguishable from a 4xx or a dropped connection.
it("throws SchemaMismatchError when the body does not match the schema", async () => {
  mockFetch(async () => new Response(JSON.stringify({ id: 42 }), { status: 200 }));
  await expect(request("/products", schema)).rejects.toBeInstanceOf(SchemaMismatchError);
});

it("requests a same-origin path, never an absolute gateway URL", async () => {
  const spy = vi.fn(async () => new Response(JSON.stringify({ id: "p1" }), { status: 200 }));
  vi.stubGlobal("fetch", spy);
  await request("/products", schema);
  expect(spy.mock.calls[0][0]).toBe("/products");
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run apps/web/src/api/__tests__/request.test.ts`
Expected: FAIL — cannot resolve `../request`.

- [ ] **Step 3: Write the error types**

`apps/web/src/api/errors.ts`:

```ts
// Three failures that need three different responses (spec §B3). Collapsing the third into a
// generic error is how a contract violation gets mistaken for an empty catalogue.
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super("the gateway could not be reached");
    this.name = "NetworkError";
    this.cause = cause;
  }
}

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`the gateway answered ${status}`);
    this.name = "HttpError";
  }
}

export class SchemaMismatchError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string
  ) {
    super(`response from ${path} did not match its contract: ${detail}`);
    this.name = "SchemaMismatchError";
  }
}
```

- [ ] **Step 4: Write the request helper**

`apps/web/src/api/request.ts`:

```ts
import type { ZodType } from "zod";
import { HttpError, NetworkError, SchemaMismatchError } from "./errors";

// The only module that knows HTTP exists. Everything above it receives typed values or typed
// errors. Paths are ALWAYS same-origin — Vite (dev) and nginx (prod) proxy them to the
// gateway, so no absolute URL and no gateway host ever enters the bundle.
export async function request<T>(path: string, schema: ZodType<T>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { accept: "application/json" } });
  } catch (cause) {
    throw new NetworkError(cause);
  }

  if (!res.ok) throw new HttpError(res.status);

  let body: unknown;
  try {
    body = await res.json();
  } catch (cause) {
    throw new SchemaMismatchError(path, `body was not JSON (${String(cause)})`);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new SchemaMismatchError(path, parsed.error.message);
  return parsed.data;
}
```

- [ ] **Step 5: Run and confirm green**

Run: `pnpm vitest run apps/web/src/api/__tests__/request.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Write the product resources**

`apps/web/src/api/products.ts`:

```ts
import { z } from "zod";
import { ProductDetailSchema, ProductListItemSchema } from "@ecom/contracts";
import { request } from "./request";

// GET /products takes NO parameters — Catalog serves the whole catalogue in one response
// (findMany with no take/skip). Sending ?limit= would imply a pagination that does not exist.
export const listProducts = () => request("/products", z.array(ProductListItemSchema));

export const getProduct = (id: string) =>
  request(`/products/${encodeURIComponent(id)}`, ProductDetailSchema);
```

- [ ] **Step 7: Write the query client with the retry policy pinned**

`apps/web/src/api/queryClient.ts`:

```ts
import { QueryClient } from "@tanstack/react-query";
import { NetworkError } from "./errors";

// React Query retries 3x on EVERY error by default. Left alone that contradicts the error
// taxonomy outright: a SchemaMismatchError is a bug that must surface at once, and a 404 is
// for a product that will never exist. Retry network failures only.
export const makeQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => error instanceof NetworkError && failureCount < 2,
        staleTime: 30_000,
      },
    },
  });
```

- [ ] **Step 8: Write the retry-policy test**

Append to `apps/web/src/api/__tests__/request.test.ts`:

```tsx
import { makeQueryClient } from "../queryClient";

it("retries network failures but never schema mismatches or 4xx", () => {
  const retry = makeQueryClient().getDefaultOptions().queries!.retry as (
    n: number,
    e: Error
  ) => boolean;
  expect(retry(0, new NetworkError("x"))).toBe(true);
  expect(retry(0, new SchemaMismatchError("/products", "bad"))).toBe(false);
  expect(retry(0, new HttpError(404))).toBe(false);
  expect(retry(5, new NetworkError("x"))).toBe(false); // bounded
});
```

- [ ] **Step 9: Run, typecheck and commit**

```bash
pnpm vitest run apps/web
pnpm typecheck && pnpm lint
git add apps/web/src/api
git commit -m "feat(web): gateway client with a typed error taxonomy and pinned retries"
```

---

### Task 4: Design tokens and primitives

**Files:**
- Modify: `apps/web/src/styles.css`
- Create: `apps/web/src/components/{Button,Badge,Card,Price,Skeleton,EmptyState,ErrorState,Silhouette}.tsx`
- Create: `apps/web/src/components/__tests__/{Price,Silhouette}.test.tsx`

**Interfaces:**
- Produces: `<Price minorUnits={number} />`, `<Silhouette type={ProductType} />`, `<Card>`,
  `<Badge>`, `<Button>`, `<Skeleton>`, `<EmptyState>`, `<ErrorState>`.

- [ ] **Step 1: Declare the tokens once**

Replace `apps/web/src/styles.css`. Values are lifted verbatim from the approved prototype;
Tailwind v4 is CSS-first, so `@theme` both declares the variables and generates utilities.
**No component may hard-code any of these values** (Global Constraint 7).

```css
@import "tailwindcss";

@theme {
  --color-paper: #f1f1f4;
  --color-surface: #ffffff;
  --color-surface-2: #f4f4f7;
  --color-ink: #1d1d1f;
  --color-ink-soft: #3c3c42;
  --color-muted: #6e6e76;
  --color-line: #e8e8ed;
  --color-line-strong: #dcdce3;

  /* Reserved to encode saga state — unused in 8a on purpose (spec §D). */
  --color-live: #b26a12;
  --color-live-bg: #fbf0de;
  --color-ok: #2e7d46;
  --color-ok-bg: #e4f1e8;
  --color-fail: #c0392b;
  --color-fail-bg: #fbe6e3;
  --color-focus: #2f73e8;

  --radius-sm: 12px;
  --radius-DEFAULT: 16px;
  --radius-lg: 24px;

  --shadow-1: 0 1px 2px rgba(20, 20, 30, 0.05), 0 6px 18px rgba(20, 20, 30, 0.06);
  --shadow-2: 0 4px 12px rgba(20, 20, 30, 0.08), 0 24px 52px rgba(20, 20, 30, 0.12);

  --font-sans:
    -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, Helvetica, Arial,
    sans-serif;
  --font-mono:
    ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace;
}

/* Dark values ship now; the toggle is 8c. Media query only. */
@media (prefers-color-scheme: dark) {
  @theme {
    --color-paper: #0c0c0f;
    --color-surface: #191a1e;
    --color-surface-2: #232429;
    --color-ink: #f2f2f4;
    --color-ink-soft: #c9cacd;
    --color-muted: #909198;
    --color-line: #2a2b31;
    --color-line-strong: #3a3b42;
    --color-live: #e4aa53;
    --color-live-bg: #2c2616;
    --color-ok: #5fbe7c;
    --color-ok-bg: #14251a;
    --color-fail: #e8776a;
    --color-fail-bg: #2c1917;
    --color-focus: #5c93f2;
  }
}

body {
  background: var(--color-paper);
  color: var(--color-ink);
  font-family: var(--font-sans);
}

/* Every datum — prices, ids, versions — is mono with tabular figures (spec §D). */
.datum {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 2: Write the failing primitive tests**

`apps/web/src/components/__tests__/Price.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { Price } from "../Price";

it.each([
  [900, "$9.00"],
  [2450, "$24.50"],
  [890000, "$8,900.00"],
  [0, "$0.00"],
])("renders %i minor units as %s", (minor, expected) => {
  render(<Price minorUnits={minor} />);
  expect(screen.getByText(expected)).toBeInTheDocument();
});
```

`apps/web/src/components/__tests__/Silhouette.test.tsx`:

```tsx
import { render } from "@testing-library/react";
import { Silhouette } from "../Silhouette";

it.each(["ELECTRONICS", "CLOTHING", "FURNITURE", "MOTORBIKE"] as const)(
  "renders a shape for %s",
  (type) => {
    const { container } = render(<Silhouette type={type} />);
    expect(container.querySelector("svg")).not.toBeNull();
  }
);

// Degrade, never crash: the union comes from a network response, so an unknown value is
// reachable if Catalog ever adds a type before the storefront knows about it.
it("degrades to a neutral shape for an unknown type", () => {
  const { container } = render(
    <Silhouette type={"SPACESHIP" as unknown as "ELECTRONICS"} />
  );
  expect(container.querySelector("svg")).not.toBeNull();
});
```

- [ ] **Step 3: Run and confirm they fail**

Run: `pnpm vitest run apps/web/src/components`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement Price and Silhouette**

`apps/web/src/components/Price.tsx`:

```tsx
// price is integer MINOR UNITS everywhere in the system; this is the only place it becomes
// a human number (Global Constraint 9).
const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function Price({ minorUnits }: { minorUnits: number }) {
  return <span className="datum">{fmt.format(minorUnits / 100)}</span>;
}
```

`apps/web/src/components/Silhouette.tsx`:

```tsx
import type { ProductType } from "@ecom/contracts";

const PATHS: Record<ProductType, string> = {
  ELECTRONICS: "M8 8h48v30H8zM4 44h56M26 38v6M38 38v6",
  CLOTHING: "M24 6l8 6 8-6 12 8-6 8-6-3v18H24V19l-6 3-6-8z",
  FURNITURE: "M14 24V12a6 6 0 016-6h24a6 6 0 016 6v12M10 24h44v10H10zM14 34v8M50 34v8",
  MOTORBIKE: "M15 34l10-16h16l6 8M25 18l-4-6h10M41 18l16 16M31 34h20",
};
const FALLBACK = "M10 10h44v28H10z";

export function Silhouette({ type }: { type: ProductType }) {
  const d = PATHS[type] ?? FALLBACK;
  return (
    <svg
      viewBox="0 0 64 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="w-1/2 text-[color:var(--color-ink-soft)]"
    >
      <path d={d} />
    </svg>
  );
}
```

- [ ] **Step 5: Implement the remaining primitives**

`apps/web/src/components/Card.tsx`:

```tsx
import type { ReactNode } from "react";

export function Card({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-surface)] shadow-[var(--shadow-1)]">
      {children}
    </div>
  );
}
```

`apps/web/src/components/Badge.tsx`:

```tsx
export function Badge({ children }: { children: string }) {
  return (
    <span className="datum rounded-full border border-[color:var(--color-line-strong)] bg-[color:var(--color-surface)] px-2 py-0.5 text-[10.5px] uppercase tracking-[0.12em] text-[color:var(--color-muted)]">
      {children}
    </span>
  );
}
```

`apps/web/src/components/Button.tsx`:

```tsx
import type { ButtonHTMLAttributes } from "react";

export function Button({
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className="inline-flex h-11 items-center justify-center rounded border border-[color:var(--color-ink)] bg-[color:var(--color-ink)] px-5 text-sm text-[color:var(--color-paper)]"
    >
      {children}
    </button>
  );
}
```

`apps/web/src/components/Skeleton.tsx`:

```tsx
// Matches the card geometry rather than being a spinner, so the grid does not reflow when
// data lands.
export function Skeleton() {
  return (
    <div
      data-testid="skeleton"
      className="h-64 animate-pulse rounded-lg bg-[color:var(--color-surface-2)]"
    />
  );
}
```

`apps/web/src/components/EmptyState.tsx`:

```tsx
export function EmptyState({ message }: { message: string }) {
  return (
    <p className="rounded border border-dashed border-[color:var(--color-line-strong)] p-12 text-center text-[color:var(--color-muted)]">
      {message}
    </p>
  );
}
```

`apps/web/src/components/ErrorState.tsx`:

```tsx
import { HttpError, NetworkError, SchemaMismatchError } from "../api/errors";
import { Button } from "./Button";

// A schema mismatch is backend drift, not a user condition — it says so plainly rather than
// rendering as "something went wrong", which is how a contract violation gets mistaken for an
// empty catalogue.
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message =
    error instanceof NetworkError
      ? "Could not reach the store. Check your connection."
      : error instanceof SchemaMismatchError
        ? "The store sent data this page does not understand. This is a bug, not you."
        : error instanceof HttpError
          ? `The store answered ${error.status}.`
          : "Something went wrong.";

  return (
    <div role="alert" className="p-12 text-center">
      <p className="text-[color:var(--color-muted)]">{message}</p>
      {error instanceof NetworkError && onRetry ? (
        <div className="mt-4">
          <Button onClick={onRetry}>Try again</Button>
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 6: Run, verify green, commit**

```bash
pnpm vitest run apps/web
pnpm typecheck && pnpm lint && pnpm format:check
git add apps/web/src/styles.css apps/web/src/components
git commit -m "feat(web): design tokens from the prototype and the primitive set"
```

---

### Task 5: Home — grid, filter, three async states

**Files:**
- Create: `apps/web/src/routes/Home.tsx`, `apps/web/src/components/ProductCard.tsx`
- Create: `apps/web/src/routes/__tests__/Home.test.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/main.tsx`

**Interfaces:**
- Consumes: `listProducts()`, `makeQueryClient()` (Task 3); primitives (Task 4).
- Produces: `<Home />`, `<ProductCard product={ProductListItem} />`.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/routes/__tests__/Home.test.tsx`:

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { makeQueryClient } from "../../api/queryClient";
import { HttpError } from "../../api/errors";
import * as api from "../../api/products";
import { Home } from "../Home";

function renderHome() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <Home />
    </QueryClientProvider>
  );
}
const product = (over = {}) => ({
  id: "p1",
  type: "ELECTRONICS" as const,
  name: "Widget",
  price: 900,
  version: 1,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

it("shows skeletons while loading", () => {
  vi.spyOn(api, "listProducts").mockReturnValue(new Promise(() => {}));
  renderHome();
  expect(screen.getAllByTestId("skeleton").length).toBeGreaterThan(0);
});

it("renders a card per product once loaded", async () => {
  vi.spyOn(api, "listProducts").mockResolvedValue([
    product(),
    product({ id: "p2", name: "Shirt", type: "CLOTHING", price: 2450 }),
  ]);
  renderHome();
  expect(await screen.findByText("Widget")).toBeInTheDocument();
  expect(screen.getByText("Shirt")).toBeInTheDocument();
  expect(screen.getByText("$9.00")).toBeInTheDocument();
});

it("shows the empty state for an empty catalogue", async () => {
  vi.spyOn(api, "listProducts").mockResolvedValue([]);
  renderHome();
  expect(await screen.findByText(/no products/i)).toBeInTheDocument();
});

it("shows the error state when the gateway errors", async () => {
  vi.spyOn(api, "listProducts").mockRejectedValue(new HttpError(500));
  renderHome();
  expect(await screen.findByRole("alert")).toHaveTextContent("500");
});

it("filters by category", async () => {
  vi.spyOn(api, "listProducts").mockResolvedValue([
    product(),
    product({ id: "p2", name: "Shirt", type: "CLOTHING" }),
  ]);
  renderHome();
  expect(await screen.findByText("Widget")).toBeInTheDocument();
  // fireEvent, not node.click(): a raw DOM click is not wrapped in act(), so the state
  // update would not be flushed before the assertions below.
  fireEvent.click(screen.getByRole("button", { name: /clothing/i }));
  expect(screen.queryByText("Widget")).not.toBeInTheDocument();
  expect(screen.getByText("Shirt")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run apps/web/src/routes`
Expected: FAIL — `../Home` not found.

- [ ] **Step 3: Implement ProductCard**

`apps/web/src/components/ProductCard.tsx`:

```tsx
import { Link } from "react-router";
import type { ProductListItem } from "@ecom/contracts";
import { Badge } from "./Badge";
import { Card } from "./Card";
import { Price } from "./Price";
import { Silhouette } from "./Silhouette";

export function ProductCard({ product }: { product: ProductListItem }) {
  return (
    <Link to={`/products/${product.id}`}>
      <Card>
        <div className="relative flex aspect-[4/3] items-center justify-center bg-[color:var(--color-surface-2)]">
          <div className="absolute left-3 top-3">
            <Badge>{product.type}</Badge>
          </div>
          <Silhouette type={product.type} />
        </div>
        <div className="flex flex-col gap-1 p-4">
          <span className="text-[15px] font-medium">{product.name}</span>
          <Price minorUnits={product.price} />
        </div>
      </Card>
    </Link>
  );
}
```

- [ ] **Step 4: Implement Home**

`apps/web/src/routes/Home.tsx`:

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ProductType } from "@ecom/contracts";
import { listProducts } from "../api/products";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { ProductCard } from "../components/ProductCard";
import { Skeleton } from "../components/Skeleton";

const CATEGORIES: (ProductType | "ALL")[] = [
  "ALL",
  "MOTORBIKE",
  "ELECTRONICS",
  "FURNITURE",
  "CLOTHING",
];

export function Home() {
  const [filter, setFilter] = useState<ProductType | "ALL">("ALL");
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ["products"],
    queryFn: listProducts,
  });

  if (isPending) {
    return (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} />
        ))}
      </div>
    );
  }
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const shown = filter === "ALL" ? data : data.filter((p) => p.type === filter);

  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            onClick={() => setFilter(c)}
            aria-pressed={filter === c}
            className="datum rounded-full border border-[color:var(--color-line)] px-3 py-1.5 text-xs uppercase"
          >
            {c}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <EmptyState message="No products in the catalogue yet." />
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {shown.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 5: Wire the router and provider**

`apps/web/src/App.tsx`:

```tsx
import { createBrowserRouter, RouterProvider } from "react-router";
import { Home } from "./routes/Home";

const router = createBrowserRouter([{ path: "/", element: <Home /> }]);

export function App() {
  return <RouterProvider router={router} />;
}
```

`apps/web/src/main.tsx` — wrap in the query provider:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { makeQueryClient } from "./api/queryClient";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={makeQueryClient()}>
      <App />
    </QueryClientProvider>
  </StrictMode>
);
```

Delete `apps/web/src/__tests__/smoke.test.tsx` — Task 1's placeholder heading is gone, and
the Home tests supersede it.

- [ ] **Step 6: Run, verify green, commit**

```bash
pnpm vitest run apps/web
pnpm typecheck && pnpm lint && pnpm format:check
git rm apps/web/src/__tests__/smoke.test.tsx
git add apps/web/src
git commit -m "feat(web): catalogue grid with loading, error and empty states"
```

---

### Task 6: Product detail — attributes, 404, safe rendering

**Files:**
- Create: `apps/web/src/routes/Product.tsx`, `apps/web/src/routes/__tests__/Product.test.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `getProduct(id)` (Task 3), primitives (Task 4).
- Produces: `<Product />` mounted at `/products/:id`.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/routes/__tests__/Product.test.tsx`:

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { makeQueryClient } from "../../api/queryClient";
import { HttpError } from "../../api/errors";
import * as api from "../../api/products";
import { Product } from "../Product";

function renderAt(id: string) {
  const router = createMemoryRouter([{ path: "/products/:id", element: <Product /> }], {
    initialEntries: [`/products/${id}`],
  });
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
const detail = (over = {}) => ({
  id: "p1",
  type: "ELECTRONICS" as const,
  name: "Widget",
  price: 900,
  version: 3,
  attributes: { manufacturer: "Acme" },
  ...over,
});

afterEach(() => vi.restoreAllMocks());

it("renders name, price and the attributes table", async () => {
  vi.spyOn(api, "getProduct").mockResolvedValue(detail());
  renderAt("p1");
  expect(await screen.findByText("Widget")).toBeInTheDocument();
  expect(screen.getByText("$9.00")).toBeInTheDocument();
  expect(screen.getByText("manufacturer")).toBeInTheDocument();
  expect(screen.getByText("Acme")).toBeInTheDocument();
});

// Reachable with nothing broken: a stale link, or a product removed between list and click.
it("renders a not-found view on 404, not a generic error", async () => {
  vi.spyOn(api, "getProduct").mockRejectedValue(new HttpError(404));
  renderAt("gone");
  expect(await screen.findByText(/not found/i)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /catalogue/i })).toBeInTheDocument();
});

it("still shows the error state for a non-404", async () => {
  vi.spyOn(api, "getProduct").mockRejectedValue(new HttpError(500));
  renderAt("p1");
  expect(await screen.findByRole("alert")).toHaveTextContent("500");
});

// attributes is z.record(z.unknown()) — values are genuinely unknown at compile time.
it("renders primitive attributes and skips non-primitive ones", async () => {
  vi.spyOn(api, "getProduct").mockResolvedValue(
    detail({ attributes: { brand: "Acme", sizes: { eu: 42 }, inStock: true } })
  );
  renderAt("p1");
  expect(await screen.findByText("brand")).toBeInTheDocument();
  expect(screen.getByText("true")).toBeInTheDocument();
  expect(screen.queryByText("sizes")).not.toBeInTheDocument();
  expect(screen.queryByText(/object Object/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run apps/web/src/routes/__tests__/Product.test.tsx`
Expected: FAIL — `../Product` not found.

- [ ] **Step 3: Implement Product**

`apps/web/src/routes/Product.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { HttpError } from "../api/errors";
import { getProduct } from "../api/products";
import { Badge } from "../components/Badge";
import { ErrorState } from "../components/ErrorState";
import { Price } from "../components/Price";
import { Silhouette } from "../components/Silhouette";
import { Skeleton } from "../components/Skeleton";

// attributes values are `unknown` by contract. Render primitives; skip everything else rather
// than emitting "[object Object]". Values are API-sourced strings, so they go through React's
// normal escaping — never dangerouslySetInnerHTML.
function primitiveEntries(attributes: Record<string, unknown>) {
  return Object.entries(attributes).filter(
    ([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean"
  ) as [string, string | number | boolean][];
}

export function Product() {
  const { id = "" } = useParams();
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ["product", id],
    queryFn: () => getProduct(id),
  });

  if (isPending) return <Skeleton />;

  if (error instanceof HttpError && error.status === 404) {
    return (
      <div className="p-12 text-center">
        <h1 className="text-2xl">Product not found</h1>
        <p className="mt-2 text-[color:var(--color-muted)]">
          It may have been removed since you last looked.
        </p>
        <Link to="/" className="datum mt-4 inline-block underline">
          Back to the catalogue
        </Link>
      </div>
    );
  }
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  return (
    <div className="grid gap-8 md:grid-cols-2">
      <div className="flex aspect-[4/3] items-center justify-center rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-surface-2)]">
        <Silhouette type={data.type} />
      </div>
      <div className="flex flex-col gap-4">
        <Badge>{data.type}</Badge>
        <h1 className="text-3xl">{data.name}</h1>
        <Price minorUnits={data.price} />
        <dl className="border-t border-[color:var(--color-line)]">
          {primitiveEntries(data.attributes).map(([k, v]) => (
            <div
              key={k}
              className="flex justify-between border-b border-[color:var(--color-line)] py-2"
            >
              <dt className="datum text-xs uppercase text-[color:var(--color-muted)]">{k}</dt>
              <dd className="datum">{String(v)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add the route**

In `apps/web/src/App.tsx`, extend the router:

```tsx
import { createBrowserRouter, RouterProvider } from "react-router";
import { Home } from "./routes/Home";
import { Product } from "./routes/Product";

const router = createBrowserRouter([
  { path: "/", element: <Home /> },
  { path: "/products/:id", element: <Product /> },
]);

export function App() {
  return <RouterProvider router={router} />;
}
```

- [ ] **Step 5: Run and confirm green**

Run: `pnpm vitest run apps/web`
Expected: PASS, all suites.

- [ ] **Step 6: Verify against the real stack**

With the stack up (`docker compose -f docker-compose.example.yml --profile app up -d`):

```bash
pnpm --filter @ecom/web dev
```

Open `http://localhost:5173`. Confirm: the grid lists real products, a card navigates to
detail, the attributes table shows real values, and `http://localhost:5173/products/nope`
renders "Product not found". Confirm in devtools that requests go to `/products` on
**port 5173**, not to 8000 — proof the proxy, not CORS, is carrying them.

- [ ] **Step 7: Commit**

```bash
pnpm typecheck && pnpm lint && pnpm format:check
git add apps/web/src
git commit -m "feat(web): product detail with a real 404 view and safe attribute rendering"
```

---

### Task 7: Documentation amendments

**Files:**
- Modify: `docs/superpowers/specs/2026-07-18-microservices-streaming-rebuild-design.md`
- Modify: `docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md`

- [ ] **Step 1: Amend the umbrella's Storefront DoD**

In the "Storefront Definition of Done" list, replace the dual-build bullet:

```markdown
- [ ] `apps/*` added to `pnpm-workspace.yaml`. `packages/contracts` is consumed as
      **TypeScript source** via its `main: src/index.ts`, exactly as all eight services
      consume it in dev and production (see each service Dockerfile's "NO tsc build step"
      comment). **A dual ESM+CJS build was specified here and withdrawn in 8a**: nothing in
      the repo imports `contracts/dist`, so the stated reason — "so the ESM/Vite app can
      import the (CJS) contracts cleanly" — did not hold.
```

And amend the config bullet:

```markdown
- [ ] Env-based config (Gateway URL) at the **proxy layer** — Vite's dev server and 8c's
      nginx — so no gateway host and zero secrets enter the bundle.
```

- [ ] **Step 2: Amend the roadmap's 8a line**

In §Phase 8 Slices, replace slice 1's opening clause:

```markdown
1. **8a — Foundation + catalogue:** `apps/*` into `pnpm-workspace.yaml` with
   `packages/contracts` consumed as TypeScript source (**the dual ESM+CJS build originally
   specified here was withdrawn in 8a — see that child spec §A1**); `apps/web` (Vite + React
   + TS + Tailwind); gateway client with zod boundary validation, with **Catalog asserting
   its own responses against the shared schemas**; home/product views with loading/error/empty
   states. Stock is **not** shown — it lives in Inventory, which the gateway does not mount.
```

- [ ] **Step 3: Verify nothing else contradicts**

```bash
grep -n "dual ESM\|CJS" docs/superpowers/specs/*.md
```

Every remaining hit must be one of the two amendments above or the 8a child spec's own §A1/§G.

- [ ] **Step 4: Commit**

```bash
pnpm format:check
git add docs/superpowers/specs/2026-07-18-microservices-streaming-rebuild-design.md docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md
git commit -m "docs(8a): withdraw the dual-build requirement and record the amendments"
```

---

## Notes for the executor

- **Global Constraint 1 is not optional.** If `vitest.config.ts` has only two globs on your
  base, you are on the wrong base — stop and rebase onto one containing 7d.
- **Every RED step must actually fail for the stated reason.** A test that fails because a
  module is missing has not yet proven the behaviour it describes; once it passes, satisfy
  yourself it would fail if the behaviour were removed. Task 2 Step 6 does this explicitly
  because that test is the drift alarm the whole slice rests on.
- Task 6 Step 6 is the only step needing the full stack. Everything else runs offline.
- Deviations go in `.scratch/phase-8a/impl-notes.html` and in the final digest's
  `Deviations:` section.
