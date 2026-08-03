# Phase 8b — Auth, cart and checkout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn 8a's read-only catalogue into a storefront that can register, log in, hold a
cart and place an order — writing no service production code.

**Architecture:** `request()` stays the only HTTP-aware module and grows mutations, a CSRF
header and a single-flight 401-refresh. The session is not a client-side guess: it is the
answer to `GET /cart`, which doubles as the cart the header badge needs. Everything above the
API layer receives typed values or typed errors.

**Tech Stack:** React 19.2, Vite 8.2, Tailwind 4.3, React Router 8.3, TanStack Query 5.101,
Vitest 2.1 + Testing Library 16.3 + jsdom 30, zod 3 via `@ecom/contracts`.

Spec: `docs/superpowers/specs/2026-08-03-phase-8b-auth-cart-checkout-design.md`.

## Global Constraints

Every task's requirements implicitly include this section.

1. **No service production code changes.** The only backend file touched is one new Order
   *test* (Task 1). If a task seems to need a service change, stop and report it.
2. **The browser only ever calls same-origin `/api/*`.** No absolute gateway URL, no CORS.
3. **`price`, `unitPrice` and `totalPrice` are integer minor units.** Divide by 100 at the
   presentation layer only — `<Price>` already does this.
4. **No hard-coded colour, radius or shadow literal.** Every one comes from a token. Radius
   utilities are `rounded-sm` / `-md` / `-lg` only — **never bare `rounded`**, which is a
   static `0.25rem` in Tailwind v4 and reads no token.
5. **New design tokens go inside the `@theme static` block** in `styles.css` or they are
   tree-shaken out of the bundle.
6. **No API-sourced value reaches `dangerouslySetInnerHTML`.**
7. **`POST /cart/items` increments** an existing line; **`PATCH /cart/items/:productId` sets**
   it, and 0 removes. A quantity stepper is a PATCH, never a repeated POST.
8. **Absence of the `XSRF-TOKEN` cookie means there is no session** — never attempt a refresh,
   never redirect from the session probe.
9. **Exactly one `POST /auth/refresh` may be in flight**, and each request retries at most once.
10. **Versions stay pinned** as 8a resolved them. Vitest stays `^2.1.0`; do not upgrade.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `packages/contracts/src/http/order.ts` | Cart + order read DTOs |
| `services/order/src/__tests__/cart-order-contract.int.test.ts` | Order asserts its own responses |
| `apps/web/src/api/csrf.ts` | Read the `XSRF-TOKEN` cookie. Nothing else. |
| `apps/web/src/api/refresh.ts` | `API` base, raw `/auth/*` calls, the single-flight refresh |
| `apps/web/src/api/session.ts` | Session probe and the auth verbs |
| `apps/web/src/api/cart.ts` | `getCart`, `addItem`, `setQuantity`, `removeItem` |
| `apps/web/src/api/orders.ts` | `placeOrder`, `getOrder` |
| `apps/web/src/hooks/useSession.ts` | The `["session"]` query + its invalidator |
| `apps/web/src/components/Layout.tsx` | Header (brand, cart badge, sign in/out) + `<Outlet/>` |
| `apps/web/src/components/RequireAuth.tsx` | Route guard carrying a return-to |
| `apps/web/src/components/Field.tsx` | Labelled input with an error slot |
| `apps/web/src/routes/Login.tsx` | Login form |
| `apps/web/src/routes/Register.tsx` | Register form |
| `apps/web/src/routes/Cart.tsx` | Cart lines, stepper, estimate, checkout |
| `apps/web/src/routes/Order.tsx` | Order confirmation |

**Modified**

| File | Change |
|---|---|
| `apps/web/src/api/errors.ts` | Add `UnauthenticatedError` |
| `apps/web/src/api/request.ts` | `init` param, CSRF header, 401 → refresh → retry once |
| `apps/web/src/App.tsx` | Layout route + five new routes |
| `apps/web/src/routes/Product.tsx` | Add-to-cart, gated |
| `packages/contracts/src/index.ts` | Export the new schemas |
| `docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md` | 8b line (Task 8) |

---

### Task 1: Cart and order read DTOs, asserted by Order itself

**Files:**
- Create: `packages/contracts/src/http/order.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `services/order/src/__tests__/cart-order-contract.int.test.ts`

**Interfaces:**
- Produces: `CartItemSchema`, `CartSchema`, `OrderItemSchema`, `PlacedOrderSchema`,
  `OrderDetailSchema`, and the inferred types `CartItem`, `Cart`, `OrderItem`, `PlacedOrder`,
  `OrderDetail`, all exported from `@ecom/contracts`.

- [ ] **Step 1: Write the failing contract test**

`services/order/src/__tests__/cart-order-contract.int.test.ts`. Order's existing int tests use
a per-test `u_${randomUUID()}` user and never share state, so no tag-cleanup block is needed
beyond `$disconnect`.

```ts
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { createApp } from "../app";
import { prisma } from "../db";
import {
  CartSchema,
  PlacedOrderSchema,
  OrderDetailSchema,
} from "@ecom/contracts";

const app = createApp();

// Order asserting its OWN responses against the shared schemas is what makes the storefront
// safe. A client that only validates on its side discovers drift at runtime, in a browser, as
// a blank cart. Here, drift fails a backend test next to the change that caused it.
describe("order cart/order API satisfies the shared contracts", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("GET /cart satisfies CartSchema", async () => {
    const userId = `u_${randomUUID()}`;
    const productId = `p_${randomUUID()}`;
    await request(app)
      .post("/cart/items")
      .set("x-user-id", userId)
      .send({ productId, quantity: 2 })
      .expect(201);

    const res = await request(app).get("/cart").set("x-user-id", userId).expect(200);
    const parsed = CartSchema.safeParse(res.body);
    if (!parsed.success) throw new Error(`cart drifted: ${parsed.error.message}`);
    expect(parsed.data.items).toEqual([{ productId, quantity: 2 }]);
  });

  it("POST /orders satisfies PlacedOrderSchema and GET /orders/:id satisfies OrderDetailSchema", async () => {
    const userId = `u_${randomUUID()}`;
    const productId = `p_${randomUUID()}`;
    // The order service prices from its catalog read-model; without a row the placement is
    // UNPRICED (422), so seed one directly, exactly as the existing suites do.
    await prisma.catalogReadModel.upsert({
      where: { productId },
      create: { productId, price: 900, version: 1 },
      update: { price: 900, version: 1 },
    });
    await request(app)
      .post("/cart/items")
      .set("x-user-id", userId)
      .send({ productId, quantity: 2 })
      .expect(201);

    const placed = await request(app).post("/orders").set("x-user-id", userId).expect(201);
    const p = PlacedOrderSchema.safeParse(placed.body);
    if (!p.success) throw new Error(`placed order drifted: ${p.error.message}`);
    expect(p.data.totalPrice).toBe(1800);

    const got = await request(app)
      .get(`/orders/${p.data.orderId}`)
      .set("x-user-id", userId)
      .expect(200);
    const d = OrderDetailSchema.safeParse(got.body);
    if (!d.success) throw new Error(`order detail drifted: ${d.error.message}`);
    expect(d.data.id).toBe(p.data.orderId);
  });

  // The two shapes are genuinely different — POST answers with `orderId` and no `userId` or
  // `createdAt`, GET with `id` plus both. One schema would have to make the identifier
  // optional, and a missing id would then parse clean.
  it("the placed and detail schemas reject each other's bodies", async () => {
    const userId = `u_${randomUUID()}`;
    const productId = `p_${randomUUID()}`;
    await prisma.catalogReadModel.upsert({
      where: { productId },
      create: { productId, price: 500, version: 1 },
      update: { price: 500, version: 1 },
    });
    await request(app)
      .post("/cart/items")
      .set("x-user-id", userId)
      .send({ productId, quantity: 1 })
      .expect(201);
    const placed = await request(app).post("/orders").set("x-user-id", userId).expect(201);
    const got = await request(app)
      .get(`/orders/${placed.body.orderId}`)
      .set("x-user-id", userId)
      .expect(200);

    expect(OrderDetailSchema.safeParse(placed.body).success).toBe(false);
    expect(PlacedOrderSchema.safeParse(got.body).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `DATABASE_URL=postgresql://ecom:ecom@localhost:5432/order pnpm vitest run services/order/src/__tests__/cart-order-contract.int.test.ts`
Expected: FAIL — `CartSchema` is not exported from `@ecom/contracts`.

- [ ] **Step 3: Write the schemas**

`packages/contracts/src/http/order.ts`:

```ts
import { z } from "zod";

// The cart and order READ API the storefront consumes. Distinct from the event payloads in
// ../events/order, which describe what the saga publishes, not what a browser fetches.
export const CartItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int(),
});
export type CartItem = z.infer<typeof CartItemSchema>;

// No names and no prices — the cart carries ids and quantities only, so any UI must join
// against the catalogue to render a line.
export const CartSchema = z.object({
  userId: z.string(),
  items: z.array(CartItemSchema),
});
export type Cart = z.infer<typeof CartSchema>;

// Integer MINOR UNITS, and the price CAPTURED at placement — not today's catalogue price.
export const OrderItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int(),
  unitPrice: z.number().int(),
});
export type OrderItem = z.infer<typeof OrderItemSchema>;

// An unrecognised status must fail loudly rather than render as a blank badge.
export const OrderStatusSchema = z.enum([
  "PENDING",
  "AWAITING_PAYMENT",
  "CONFIRMED",
  "CANCELLED",
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

// TWO schemas, because Order returns two shapes: POST answers `orderId` with no `userId` or
// `createdAt`; GET answers `id` with both. Collapsing them would force an optional
// identifier, and an absent id would then parse clean.
export const PlacedOrderSchema = z.object({
  orderId: z.string(),
  status: OrderStatusSchema,
  totalPrice: z.number().int(),
  items: z.array(OrderItemSchema),
});
export type PlacedOrder = z.infer<typeof PlacedOrderSchema>;

export const OrderDetailSchema = z.object({
  id: z.string(),
  userId: z.string(),
  status: OrderStatusSchema,
  totalPrice: z.number().int(),
  items: z.array(OrderItemSchema),
  createdAt: z.string(),
});
export type OrderDetail = z.infer<typeof OrderDetailSchema>;
```

- [ ] **Step 4: Export them**

Add to `packages/contracts/src/index.ts`, after the existing `export * from "./http/catalog";`:

```ts
export * from "./http/order";
```

- [ ] **Step 5: Run and confirm green**

Run: `DATABASE_URL=postgresql://ecom:ecom@localhost:5432/order pnpm vitest run services/order/src/__tests__/cart-order-contract.int.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Prove the test discriminates**

The whole value is that drift fails here. Temporarily change `totalPrice` in
`PlacedOrderSchema` to `z.string()`, re-run, and confirm the placed-order test fails with a
message naming `totalPrice`. Restore byte-identical and re-run to confirm green.

- [ ] **Step 7: Typecheck, format and commit**

```bash
pnpm typecheck && pnpm format:check
git add packages/contracts/src/http/order.ts packages/contracts/src/index.ts services/order/src/__tests__/cart-order-contract.int.test.ts
git commit -m "feat(contracts): cart and order read DTOs, asserted by Order itself"
```

---

### Task 2: `request()` grows mutations, CSRF and a single-flight refresh

The riskiest task in the slice. An implementation that refreshes once per failing request
passes every outcome-shaped assertion while quietly storming a rate-limited endpoint.

**Files:**
- Create: `apps/web/src/api/csrf.ts`, `apps/web/src/api/refresh.ts`
- Modify: `apps/web/src/api/errors.ts`, `apps/web/src/api/request.ts`
- Create: `apps/web/src/api/__tests__/csrf.test.ts`, `apps/web/src/api/__tests__/refresh.test.ts`

**Module boundaries matter here.** `refresh.ts` imports only `csrf.ts`, and `request.ts`
imports `refresh.ts`. Nothing in this task imports the cart, which is what keeps
`request → refresh → csrf` a straight line. Putting the session probe in this module instead
would close a cycle back through `cart.ts`, and ESM would paper over it until the day it
didn't.

**Interfaces:**
- Produces: `readCsrfToken(): string | null`; `UnauthenticatedError`;
  `request<T>(path, schema, init?)`; `refreshSession(): Promise<boolean>`;
  `authRequest(path, body?): Promise<Response>`.

- [ ] **Step 1: Write the failing CSRF test**

`apps/web/src/api/__tests__/csrf.test.ts`:

```ts
import { readCsrfToken } from "../csrf";

afterEach(() => {
  document.cookie = "XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});

it("reads the XSRF-TOKEN cookie", () => {
  document.cookie = "XSRF-TOKEN=abc123; path=/";
  expect(readCsrfToken()).toBe("abc123");
});

it("returns null when the cookie is absent", () => {
  expect(readCsrfToken()).toBeNull();
});

it("picks XSRF-TOKEN out of several cookies", () => {
  document.cookie = "other=1; path=/";
  document.cookie = "XSRF-TOKEN=xyz; path=/";
  expect(readCsrfToken()).toBe("xyz");
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run apps/web/src/api/__tests__/csrf.test.ts`
Expected: FAIL — cannot resolve `../csrf`.

- [ ] **Step 3: Implement the cookie reader**

`apps/web/src/api/csrf.ts`:

```ts
// The one cookie JavaScript is allowed to read. access_token and refresh_token are httpOnly
// by design; XSRF-TOKEN deliberately is not, because the client has to echo it back in a
// header — that asymmetry is the whole double-submit defence.
export const CSRF_COOKIE = "XSRF-TOKEN";

export function readCsrfToken(): string | null {
  for (const part of document.cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === CSRF_COOKIE) return rest.join("=") || null;
  }
  return null;
}
```

- [ ] **Step 4: Run and confirm green**

Run: `pnpm vitest run apps/web/src/api/__tests__/csrf.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Add the unauthenticated error**

Append to `apps/web/src/api/errors.ts`:

```ts
// Distinct from HttpError(401): this means "no usable session, and refreshing did not help",
// which is a routing decision (go to /login). A 401 from /auth/login itself is a rejected
// credential and stays an HttpError so the form can say so without redirecting.
export class UnauthenticatedError extends Error {
  constructor() {
    super("not signed in");
    this.name = "UnauthenticatedError";
  }
}
```

- [ ] **Step 6: Write the failing refresh tests**

`apps/web/src/api/__tests__/refresh.test.ts`. These are the drift alarm for this task —
note the **call-count** assertions.

```ts
import { z } from "zod";
import { request } from "../request";
import { UnauthenticatedError } from "../errors";

const schema = z.object({ ok: z.boolean() });

function setCsrf(value: string | null) {
  document.cookie = value
    ? `XSRF-TOKEN=${value}; path=/`
    : "XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
}
afterEach(() => {
  setCsrf(null);
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

it("refreshes once and retries when a 401 is recoverable", async () => {
  setCsrf("t1");
  let calls = 0;
  const spy = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === "/api/auth/refresh") return json({ ok: true });
    calls += 1;
    return calls === 1 ? json({ error: "unauthenticated" }, 401) : json({ ok: true });
  });
  vi.stubGlobal("fetch", spy);

  await expect(request("/api/cart", schema)).resolves.toEqual({ ok: true });
  expect(spy.mock.calls.filter((c) => String(c[0]) === "/api/auth/refresh")).toHaveLength(1);
});

// The assertion that matters. A per-request refresh passes every outcome-shaped test above
// while firing N refreshes at an endpoint capped to 10/min, and leaning on identity's grace
// window to avoid destroying its own session through reuse detection.
it("issues exactly ONE refresh for concurrent 401s", async () => {
  setCsrf("t1");
  const seen: Record<string, number> = {};
  const spy = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    seen[url] = (seen[url] ?? 0) + 1;
    if (url === "/api/auth/refresh") {
      await new Promise((r) => setTimeout(r, 10));
      return json({ ok: true });
    }
    return seen[url] === 1 ? json({ error: "unauthenticated" }, 401) : json({ ok: true });
  });
  vi.stubGlobal("fetch", spy);

  await Promise.all([
    request("/api/a", schema),
    request("/api/b", schema),
    request("/api/c", schema),
  ]);
  expect(seen["/api/auth/refresh"]).toBe(1);
});

it("never refreshes when there is no XSRF-TOKEN cookie", async () => {
  setCsrf(null);
  const spy = vi.fn<typeof fetch>(async () => json({ error: "unauthenticated" }, 401));
  vi.stubGlobal("fetch", spy);

  await expect(request("/api/cart", schema)).rejects.toBeInstanceOf(UnauthenticatedError);
  expect(spy.mock.calls.map((c) => String(c[0]))).not.toContain("/api/auth/refresh");
});

it("does not loop when the retry also 401s", async () => {
  setCsrf("t1");
  const spy = vi.fn<typeof fetch>(async (input) =>
    String(input) === "/api/auth/refresh"
      ? json({ ok: true })
      : json({ error: "unauthenticated" }, 401)
  );
  vi.stubGlobal("fetch", spy);

  await expect(request("/api/cart", schema)).rejects.toBeInstanceOf(UnauthenticatedError);
  expect(spy.mock.calls.filter((c) => String(c[0]) === "/api/auth/refresh")).toHaveLength(1);
});

it("sends X-CSRF-Token on a mutation and no body on a GET", async () => {
  setCsrf("tok");
  const spy = vi.fn<typeof fetch>(async () => json({ ok: true }));
  vi.stubGlobal("fetch", spy);

  await request("/api/cart/items", schema, {
    method: "POST",
    body: { productId: "p1", quantity: 1 },
  });
  const init = spy.mock.calls[0][1]!;
  expect((init.headers as Record<string, string>)["x-csrf-token"]).toBe("tok");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body as string)).toEqual({ productId: "p1", quantity: 1 });
});
```

- [ ] **Step 7: Run and confirm they fail**

Run: `pnpm vitest run apps/web/src/api/__tests__/refresh.test.ts`
Expected: FAIL — `request` takes two arguments and never calls `/api/auth/refresh`.

- [ ] **Step 8: Implement the single-flight refresh**

`apps/web/src/api/refresh.ts` — the refresh uses raw `fetch`, never `request()`, so a 401 from
the refresh endpoint cannot recurse into the retry path:

```ts
import { readCsrfToken } from "./csrf";

export const API = "/api";

// Raw access to /auth/*. These paths are CSRF-exempt at the gateway except logout, carry no
// session yet, and must never enter request()'s refresh-and-retry path.
export async function authRequest(path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  // Logout is NOT in the gateway's CSRF exempt list; login/register/refresh are.
  const token = readCsrfToken();
  if (token) headers["x-csrf-token"] = token;
  return fetch(`${API}${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ONE refresh at a time. Identity rotates refresh tokens and detects reuse family-scoped, and
// /auth/* is capped at 10 requests a minute — so a page issuing parallel queries after the
// access token expires must not fire one refresh per query.
let inFlight: Promise<boolean> | null = null;

export function refreshSession(): Promise<boolean> {
  if (!inFlight) {
    inFlight = authRequest("/auth/refresh")
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}
```

- [ ] **Step 9: Rewrite `request()`**

`apps/web/src/api/request.ts` — replace the file:

```ts
import type { ZodType } from "zod";
import { readCsrfToken } from "./csrf";
import { refreshSession } from "./refresh";
import {
  HttpError,
  NetworkError,
  SchemaMismatchError,
  UnauthenticatedError,
} from "./errors";

export type RequestInit_ = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
};

// The only module that knows HTTP exists. Everything above it receives typed values or typed
// errors. Paths are ALWAYS same-origin under /api — Vite (dev) and nginx (prod) proxy them to
// the gateway, so no absolute URL and no gateway host ever enters the bundle. Cookies ride
// automatically: fetch defaults to same-origin credentials.
async function send(path: string, init: RequestInit_): Promise<Response> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") {
    const token = readCsrfToken();
    // The gateway compares this header against the cookie and 403s a mismatch. No cookie
    // means no session at all — a client-side fact, so say so rather than spend a round trip.
    if (!token) throw new UnauthenticatedError();
    headers["x-csrf-token"] = token;
  }
  return fetch(path, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

export async function request<T>(
  path: string,
  schema: ZodType<T>,
  init: RequestInit_ = {}
): Promise<T> {
  let res: Response;
  try {
    res = await send(path, init);
  } catch (cause) {
    if (cause instanceof UnauthenticatedError) throw cause;
    throw new NetworkError(cause);
  }

  if (res.status === 401) {
    // No XSRF cookie means there is no session to refresh. Attempting one would bounce an
    // anonymous visitor to /login on a public page and burn the auth rate limit doing it.
    if (!readCsrfToken()) throw new UnauthenticatedError();
    const refreshed = await refreshSession();
    if (!refreshed) throw new UnauthenticatedError();
    try {
      res = await send(path, init);
    } catch (cause) {
      if (cause instanceof UnauthenticatedError) throw cause;
      throw new NetworkError(cause);
    }
    // A second 401 after a successful refresh is a real failure. Never loop.
    if (res.status === 401) throw new UnauthenticatedError();
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

- [ ] **Step 10: Run the whole api suite**

Run: `pnpm vitest run apps/web/src/api`
Expected: PASS. `request.test.ts` from 8a still passes — its calls are GETs with no cookie set,
which take the unchanged path.

- [ ] **Step 11: Prove the single-flight assertion discriminates**

Temporarily replace `refreshSession`'s body in `refresh.ts` with a plain
`return authRequest("/auth/refresh").then((r) => r.ok);` (no `inFlight` memo). Re-run
`refresh.test.ts` and confirm **"issues exactly ONE refresh for concurrent 401s" fails** with
`expected 3 to be 1`. Restore byte-identical and confirm green. This is the defect the task
exists to prevent; do not skip this step.

- [ ] **Step 12: Typecheck, lint, format and commit**

```bash
pnpm typecheck && pnpm lint && pnpm format:check
git add apps/web/src/api
git commit -m "feat(web): mutations, CSRF and a single-flight refresh in the API layer"
```

---

### Task 3: Session state, the layout header and the route guard

**Files:**
- Create: `apps/web/src/api/cart.ts`, `apps/web/src/hooks/useSession.ts`,
  `apps/web/src/components/Layout.tsx`, `apps/web/src/components/RequireAuth.tsx`
- Create: `apps/web/src/components/__tests__/RequireAuth.test.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/api/session.ts`

**Interfaces:**
- Consumes: `request`, `UnauthenticatedError`, `authRequest` (Task 2); `CartSchema` (Task 1).
- Produces: `getCart()`, `addItem()`, `setQuantity()`, `removeItem()`; `probeSession()`;
  `useSession()` returning `{ data, isPending }` where data is
  `{ authenticated: boolean; cart: Cart | null }`; `<RequireAuth>`; `<Layout>`.

- [ ] **Step 1: Write the cart resource module**

`apps/web/src/api/cart.ts`:

```ts
import { z } from "zod";
import { CartSchema } from "@ecom/contracts";
import { request } from "./request";
import { API } from "./refresh";

// Every mutation answers 200 with a small JSON body — none of them is 204, so parsing is
// safe. Schemas rather than z.unknown(): a mutation that silently starts answering something
// else should fail here, not three screens later.
const AddedSchema = z.object({ productId: z.string() });
const SetSchema = z.object({ productId: z.string(), quantity: z.number().int() });

export const getCart = () => request(`${API}/cart`, CartSchema);

// POST INCREMENTS an existing line. PATCH SETS it, and 0 removes. A stepper must PATCH —
// built on POST it would add to the line instead of replacing it, doubling on every click.
export const addItem = (productId: string, quantity: number) =>
  request(`${API}/cart/items`, AddedSchema, {
    method: "POST",
    body: { productId, quantity },
  });

// 404 `not in cart` if the line is already gone — treat as success, the end state matches.
export const setQuantity = (productId: string, quantity: number) =>
  request(`${API}/cart/items/${encodeURIComponent(productId)}`, SetSchema, {
    method: "PATCH",
    body: { quantity },
  });

export const removeItem = (productId: string) =>
  request(`${API}/cart/items/${encodeURIComponent(productId)}`, AddedSchema, {
    method: "DELETE",
  });
```

- [ ] **Step 2: Add the session probe**

`apps/web/src/api/session.ts` — a new module. It sits **above** `cart.ts` and `refresh.ts` and
is imported by neither, which is what keeps the API layer acyclic:

```ts
import type { Cart } from "@ecom/contracts";
import { authRequest } from "./refresh";
import { getCart } from "./cart";
import { UnauthenticatedError } from "./errors";

export type Session = { authenticated: boolean; cart: Cart | null };

// The session is whatever GET /cart says. The XSRF cookie cannot stand in for this: the
// gateway clears it on logout and on a rejected refresh, but nothing clears it when the
// refresh token merely expires, so the header would claim a session the server forgot.
// A 401 here resolves to "logged out" — it never redirects. Redirecting is the answer to an
// unauthenticated protected route, not to the question "is anyone signed in?".
export async function probeSession(): Promise<Session> {
  try {
    return { authenticated: true, cart: await getCart() };
  } catch (e) {
    if (e instanceof UnauthenticatedError) return { authenticated: false, cart: null };
    throw e;
  }
}

export const login = (email: string, password: string) =>
  authRequest("/auth/login", { email, password });
export const register = (email: string, password: string, name: string) =>
  authRequest("/auth/register", { email, password, name });
export const logout = () => authRequest("/auth/logout");
```

- [ ] **Step 3: Write the session hook**

`apps/web/src/hooks/useSession.ts`:

```ts
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { probeSession } from "../api/session";

export const SESSION_KEY = ["session"] as const;

export function useSession() {
  return useQuery({ queryKey: SESSION_KEY, queryFn: probeSession });
}

// Every cart mutation and the checkout invalidate this — POST /orders clears the cart inside
// the same transaction that writes the order, so the badge is stale the moment it returns.
export function useInvalidateSession() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: SESSION_KEY });
}
```

- [ ] **Step 4: Write the failing guard test**

`apps/web/src/components/__tests__/RequireAuth.test.tsx`:

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { makeQueryClient } from "../../api/queryClient";
import * as session from "../../api/session";
import { RequireAuth } from "../RequireAuth";

function renderGuarded(initial = "/cart") {
  const router = createMemoryRouter(
    [
      {
        path: "/cart",
        element: (
          <RequireAuth>
            <p>the cart</p>
          </RequireAuth>
        ),
      },
      { path: "/login", element: <p>sign in please</p> },
    ],
    { initialEntries: [initial] }
  );
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
afterEach(() => vi.restoreAllMocks());

it("renders the page when a session exists", async () => {
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [] },
  });
  renderGuarded();
  expect(await screen.findByText("the cart")).toBeInTheDocument();
});

it("redirects to login when there is no session", async () => {
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: false,
    cart: null,
  });
  renderGuarded();
  expect(await screen.findByText("sign in please")).toBeInTheDocument();
});
```

- [ ] **Step 5: Run and confirm it fails**

Run: `pnpm vitest run apps/web/src/components/__tests__/RequireAuth.test.tsx`
Expected: FAIL — cannot resolve `../RequireAuth`.

- [ ] **Step 6: Implement the guard**

`apps/web/src/components/RequireAuth.tsx`:

```tsx
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useSession } from "../hooks/useSession";
import { Skeleton } from "./Skeleton";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { data, isPending } = useSession();
  const location = useLocation();

  if (isPending) return <Skeleton />;
  if (!data?.authenticated)
    // `state.from` is what sends the user back where they were aiming after they sign in.
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <>{children}</>;
}
```

- [ ] **Step 7: Implement the layout**

`apps/web/src/components/Layout.tsx`:

```tsx
import { Link, Outlet, useNavigate } from "react-router";
import { useSession, useInvalidateSession } from "../hooks/useSession";
import { logout } from "../api/session";
import { Button } from "./Button";

export function Layout() {
  const { data } = useSession();
  const invalidate = useInvalidateSession();
  const navigate = useNavigate();
  const count = (data?.cart?.items ?? []).reduce((n, i) => n + i.quantity, 0);

  async function signOut() {
    await logout();
    await invalidate();
    navigate("/");
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-8 flex items-center justify-between">
        <Link to="/" className="text-lg font-medium">
          Storefront
        </Link>
        <nav className="flex items-center gap-4">
          <Link to="/cart" className="datum text-sm">
            Cart ({count})
          </Link>
          {data?.authenticated ? (
            <Button onClick={signOut}>Sign out</Button>
          ) : (
            <Link to="/login" className="datum text-sm underline">
              Sign in
            </Link>
          )}
        </nav>
      </header>
      <Outlet />
    </div>
  );
}
```

- [ ] **Step 8: Wire the routes**

`apps/web/src/App.tsx` — replace the file. Routes for `/login`, `/register`, `/cart` and
`/orders/:id` are added here; their components arrive in Tasks 4, 5 and 7, so this step is
where the router shape lands, and each later task fills its element in.

```tsx
import { createBrowserRouter, RouterProvider } from "react-router";
import { Layout } from "./components/Layout";
import { Home } from "./routes/Home";
import { Product } from "./routes/Product";

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/products/:id", element: <Product /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
```

- [ ] **Step 9: Run, typecheck, lint, format and commit**

```bash
pnpm vitest run --project @ecom/web
pnpm typecheck && pnpm lint && pnpm format:check
git add apps/web/src
git commit -m "feat(web): session derived from the server, layout header and route guard"
```

Expected: all suites pass, including 8a's Home and Product tests — they render inside
`MemoryRouter`, not the layout, so the header does not affect them.

---

### Task 4: Login and register

**Files:**
- Create: `apps/web/src/components/Field.tsx`, `apps/web/src/routes/Login.tsx`,
  `apps/web/src/routes/Register.tsx`
- Create: `apps/web/src/routes/__tests__/Login.test.tsx`,
  `apps/web/src/routes/__tests__/Register.test.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `login`, `register` (Task 3); `useInvalidateSession` (Task 3).
- Produces: `<Login>`, `<Register>`, `<Field>`.

- [ ] **Step 1: Write the failing login test**

`apps/web/src/routes/__tests__/Login.test.tsx`:

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { makeQueryClient } from "../../api/queryClient";
import * as session from "../../api/session";
import { Login } from "../Login";

function renderLogin(state?: { from: string }) {
  const router = createMemoryRouter(
    [
      { path: "/login", element: <Login /> },
      { path: "/", element: <p>home</p> },
      { path: "/cart", element: <p>the cart</p> },
    ],
    { initialEntries: [{ pathname: "/login", state }] }
  );
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
const ok = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

afterEach(() => vi.restoreAllMocks());

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText(/email/i), {
    target: { value: "a@b.com" },
  });
  fireEvent.change(screen.getByLabelText(/password/i), {
    target: { value: "hunter2hunter2" },
  });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

it("returns to where the guard sent the user from", async () => {
  vi.spyOn(session, "login").mockResolvedValue(ok(200, { ok: true }));
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [] },
  });
  renderLogin({ from: "/cart" });
  fillAndSubmit();
  expect(await screen.findByText("the cart")).toBeInTheDocument();
});

// A wrong password must not redirect — it is a rejected credential, not a missing session.
it("keeps a rejected credential on the form", async () => {
  vi.spyOn(session, "login").mockResolvedValue(ok(401, { error: "invalid credentials" }));
  renderLogin();
  fillAndSubmit();
  expect(await screen.findByText(/email or password is wrong/i)).toBeInTheDocument();
});

it("explains a 429 rather than showing a status code", async () => {
  vi.spyOn(session, "login").mockResolvedValue(ok(429, {}));
  renderLogin();
  fillAndSubmit();
  expect(await screen.findByText(/too many attempts/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run apps/web/src/routes/__tests__/Login.test.tsx`
Expected: FAIL — cannot resolve `../Login`.

- [ ] **Step 3: Implement the field primitive**

`apps/web/src/components/Field.tsx`:

```tsx
import type { InputHTMLAttributes } from "react";

export function Field({
  label,
  error,
  ...rest
}: { label: string; error?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1">
      <span className="datum text-xs uppercase text-[color:var(--color-muted)]">{label}</span>
      <input
        {...rest}
        className="h-11 rounded-md border border-[color:var(--color-line-strong)] bg-[color:var(--color-surface)] px-3"
      />
      {error ? <span className="text-sm text-[color:var(--color-fail)]">{error}</span> : null}
    </label>
  );
}
```

- [ ] **Step 4: Implement login**

`apps/web/src/routes/Login.tsx`:

```tsx
import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { login } from "../api/session";
import { useInvalidateSession } from "../hooks/useSession";
import { Button } from "../components/Button";
import { Field } from "../components/Field";

export function Login() {
  const location = useLocation();
  const navigate = useNavigate();
  const invalidate = useInvalidateSession();
  const state = location.state as { from?: string; email?: string } | null;
  const [email, setEmail] = useState(state?.email ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await login(email, password);
    if (res.status === 401) return setError("That email or password is wrong.");
    if (res.status === 429)
      return setError("Too many attempts. Wait a minute and try again.");
    if (!res.ok) return setError("Could not sign in. Try again.");
    await invalidate();
    navigate(state?.from ?? "/", { replace: true });
  }

  return (
    <form onSubmit={submit} className="mx-auto flex max-w-sm flex-col gap-4">
      <h1 className="text-2xl">Sign in</h1>
      <Field
        label="Email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <Field
        label="Password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {error ? <p className="text-sm text-[color:var(--color-fail)]">{error}</p> : null}
      <Button type="submit">Sign in</Button>
      <Link to="/register" className="datum text-sm underline">
        Create an account
      </Link>
    </form>
  );
}
```

- [ ] **Step 5: Write the failing register test**

`apps/web/src/routes/__tests__/Register.test.tsx`:

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { makeQueryClient } from "../../api/queryClient";
import * as session from "../../api/session";
import { Register } from "../Register";
import { Login } from "../Login";

function renderRegister() {
  const router = createMemoryRouter(
    [
      { path: "/register", element: <Register /> },
      { path: "/login", element: <Login /> },
    ],
    { initialEntries: ["/register"] }
  );
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
const res = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

afterEach(() => vi.restoreAllMocks());

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Ada" } });
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@b.com" } });
  fireEvent.change(screen.getByLabelText(/password/i), {
    target: { value: "hunter2hunter2" },
  });
  fireEvent.click(screen.getByRole("button", { name: /create account/i }));
}

// Register returns 201 {userId} and NO tokens, and the gateway sets no cookies on that path —
// so a new user is still anonymous and must sign in.
it("lands on the login form with the email prefilled", async () => {
  vi.spyOn(session, "register").mockResolvedValue(res(201, { userId: "u1" }));
  renderRegister();
  fillAndSubmit();
  expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();
  expect(screen.getByLabelText(/email/i)).toHaveValue("a@b.com");
});

it("puts a duplicate email on the field with a way to sign in", async () => {
  vi.spyOn(session, "register").mockResolvedValue(
    res(409, { error: "email already registered" })
  );
  renderRegister();
  fillAndSubmit();
  expect(await screen.findByText(/already registered/i)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /sign in/i })).toBeInTheDocument();
});
```

- [ ] **Step 6: Run and confirm it fails**

Run: `pnpm vitest run apps/web/src/routes/__tests__/Register.test.tsx`
Expected: FAIL — cannot resolve `../Register`.

- [ ] **Step 7: Implement register**

`apps/web/src/routes/Register.tsx`:

```tsx
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { register } from "../api/session";
import { Button } from "../components/Button";
import { Field } from "../components/Field";

export function Register() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setEmailError(null);
    setError(null);
    const res = await register(email, password, name);
    if (res.status === 409)
      return setEmailError("That email is already registered.");
    if (res.status === 429)
      return setError("Too many attempts. Wait a minute and try again.");
    if (!res.ok) return setError("Could not create the account. Try again.");
    // Registering does not sign you in — identity returns no tokens and the gateway sets no
    // cookies here. Carry the email so the next step is one field, not two.
    navigate("/login", { state: { email }, replace: true });
  }

  return (
    <form onSubmit={submit} className="mx-auto flex max-w-sm flex-col gap-4">
      <h1 className="text-2xl">Create account</h1>
      <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
      <Field
        label="Email"
        type="email"
        value={email}
        error={emailError ?? undefined}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <Field
        label="Password"
        type="password"
        minLength={8}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {error ? <p className="text-sm text-[color:var(--color-fail)]">{error}</p> : null}
      <Button type="submit">Create account</Button>
      <Link to="/login" className="datum text-sm underline">
        Sign in instead
      </Link>
    </form>
  );
}
```

- [ ] **Step 8: Add both routes**

In `apps/web/src/App.tsx`, import `Login` and `Register` and add to the layout's `children`:

```tsx
      { path: "/login", element: <Login /> },
      { path: "/register", element: <Register /> },
```

- [ ] **Step 9: Run, typecheck, lint, format and commit**

```bash
pnpm vitest run --project @ecom/web
pnpm typecheck && pnpm lint && pnpm format:check
git add apps/web/src
git commit -m "feat(web): login and register, with register landing on a prefilled sign-in"
```

---

### Task 5: The cart page

**Files:**
- Create: `apps/web/src/routes/Cart.tsx`, `apps/web/src/routes/__tests__/Cart.test.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `useSession`, `useInvalidateSession` (Task 3); `setQuantity`, `removeItem`
  (Task 3); `listProducts` (8a); `RequireAuth` (Task 3).
- Produces: `<Cart>`.

- [ ] **Step 1: Write the failing cart test**

`apps/web/src/routes/__tests__/Cart.test.tsx`:

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { makeQueryClient } from "../../api/queryClient";
import * as productsApi from "../../api/products";
import * as cartApi from "../../api/cart";
import * as session from "../../api/session";
import { Cart } from "../Cart";

function renderCart() {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={makeQueryClient()}>
        <Cart />
      </QueryClientProvider>
    </MemoryRouter>
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

it("joins names and prices from the catalogue", async () => {
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [{ productId: "p1", quantity: 2 }] },
  });
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([product()]);
  renderCart();
  expect(await screen.findByText("Widget")).toBeInTheDocument();
  expect(screen.getByText("$18.00")).toBeInTheDocument(); // 900 * 2
});

// Reachable with nothing broken: a product deleted from the catalogue after it was added.
it("degrades to the id for a product missing from the catalogue", async () => {
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [{ productId: "ghost", quantity: 1 }] },
  });
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([product()]);
  renderCart();
  expect(await screen.findByText("ghost")).toBeInTheDocument();
});

it("labels the total as an estimate", async () => {
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [{ productId: "p1", quantity: 1 }] },
  });
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([product()]);
  renderCart();
  expect(await screen.findByText(/estimate/i)).toBeInTheDocument();
});

// The stepper must PATCH. POST increments, so a stepper built on POST would double the line.
it("changes a quantity with PATCH, not a repeated POST", async () => {
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [{ productId: "p1", quantity: 2 }] },
  });
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([product()]);
  const set = vi.spyOn(cartApi, "setQuantity").mockResolvedValue(undefined);
  const add = vi.spyOn(cartApi, "addItem");
  renderCart();
  await screen.findByText("Widget");
  fireEvent.click(screen.getByRole("button", { name: /increase/i }));
  expect(set).toHaveBeenCalledWith("p1", 3);
  expect(add).not.toHaveBeenCalled();
});

it("shows an empty state for an empty cart", async () => {
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [] },
  });
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([]);
  renderCart();
  expect(await screen.findByText(/cart is empty/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm vitest run apps/web/src/routes/__tests__/Cart.test.tsx`
Expected: FAIL — cannot resolve `../Cart`.

- [ ] **Step 3: Implement the cart**

`apps/web/src/routes/Cart.tsx`:

Checkout belongs to Task 7 — this task ships the cart alone, so it imports nothing that does
not yet exist and its suite is green on its own commit.

```tsx
import { useQuery } from "@tanstack/react-query";
import { listProducts } from "../api/products";
import { removeItem, setQuantity } from "../api/cart";
import { useInvalidateSession, useSession } from "../hooks/useSession";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { Price } from "../components/Price";
import { Skeleton } from "../components/Skeleton";

export function Cart() {
  const invalidate = useInvalidateSession();
  const session = useSession();
  const products = useQuery({ queryKey: ["products"], queryFn: listProducts });

  if (session.isPending || products.isPending) return <Skeleton />;
  if (session.error) return <ErrorState error={session.error} />;

  const items = session.data?.cart?.items ?? [];
  if (items.length === 0) return <EmptyState message="Your cart is empty." />;

  // The cart carries ids and quantities only, so names and prices come from the catalogue the
  // storefront already caches. A product deleted since it was added degrades to its id.
  const byId = new Map((products.data ?? []).map((p) => [p.id, p]));
  const estimate = items.reduce(
    (sum, i) => sum + (byId.get(i.productId)?.price ?? 0) * i.quantity,
    0
  );

  async function change(productId: string, quantity: number) {
    if (quantity <= 0) await removeItem(productId);
    else await setQuantity(productId, quantity);
    await invalidate();
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl">Cart</h1>
      <ul className="flex flex-col gap-3">
        {items.map((i) => {
          const p = byId.get(i.productId);
          return (
            <li
              key={i.productId}
              className="flex items-center justify-between border-b border-[color:var(--color-line)] py-3"
            >
              <span>{p?.name ?? i.productId}</span>
              <span className="flex items-center gap-3">
                {p ? <Price minorUnits={p.price * i.quantity} /> : null}
                <button
                  aria-label={`decrease ${p?.name ?? i.productId}`}
                  onClick={() => void change(i.productId, i.quantity - 1)}
                  className="datum rounded-sm border border-[color:var(--color-line)] px-2"
                >
                  −
                </button>
                <span className="datum">{i.quantity}</span>
                <button
                  aria-label={`increase ${p?.name ?? i.productId}`}
                  onClick={() => void change(i.productId, i.quantity + 1)}
                  className="datum rounded-sm border border-[color:var(--color-line)] px-2"
                >
                  +
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="flex items-center justify-between">
        <span className="datum text-xs uppercase text-[color:var(--color-muted)]">
          Estimate — the price charged is set when you place the order
        </span>
        <Price minorUnits={estimate} />
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Add the route, guarded**

In `apps/web/src/App.tsx`, add to the layout's `children`:

```tsx
      {
        path: "/cart",
        element: (
          <RequireAuth>
            <Cart />
          </RequireAuth>
        ),
      },
```

- [ ] **Step 5: Run, typecheck, lint, format and commit**

```bash
pnpm vitest run --project @ecom/web
pnpm typecheck && pnpm lint && pnpm format:check
git add apps/web/src
git commit -m "feat(web): cart page with a catalogue join and an honest estimate"
```

---

### Task 6: Add to cart, gated behind a session

**Files:**
- Modify: `apps/web/src/routes/Product.tsx`
- Modify: `apps/web/src/routes/__tests__/Product.test.tsx`

**Interfaces:**
- Consumes: `addItem` (Task 3), `useSession`, `useInvalidateSession` (Task 3).

- [ ] **Step 1: Add the failing tests**

Append to `apps/web/src/routes/__tests__/Product.test.tsx`. Add the imports
`import * as cartApi from "../../api/cart";` and `import * as session from "../../api/session";`
at the top, and extend `renderAt` to accept extra routes:

```tsx
it("sends a logged-out visitor to sign in, remembering the product", async () => {
  vi.spyOn(api, "getProduct").mockResolvedValue(detail());
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: false,
    cart: null,
  });
  const router = createMemoryRouter(
    [
      { path: "/products/:id", element: <Product /> },
      { path: "/login", element: <p>sign in please</p> },
    ],
    { initialEntries: ["/products/p1"] }
  );
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  fireEvent.click(await screen.findByRole("button", { name: /add to cart/i }));
  expect(await screen.findByText("sign in please")).toBeInTheDocument();
});

it("adds to the cart when signed in", async () => {
  vi.spyOn(api, "getProduct").mockResolvedValue(detail());
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [] },
  });
  const add = vi.spyOn(cartApi, "addItem").mockResolvedValue({ productId: "p1" });
  renderAt("p1");
  fireEvent.click(await screen.findByRole("button", { name: /add to cart/i }));
  expect(add).toHaveBeenCalledWith("p1", 1);
});
```

`fireEvent` must be added to the `@testing-library/react` import.

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm vitest run apps/web/src/routes/__tests__/Product.test.tsx`
Expected: FAIL — no button named "Add to cart".

- [ ] **Step 3: Add the gated button**

In `apps/web/src/routes/Product.tsx`, add these imports:

```tsx
import { useLocation, useNavigate } from "react-router";
import { addItem } from "../api/cart";
import { useInvalidateSession, useSession } from "../hooks/useSession";
import { Button } from "../components/Button";
```

Inside `Product()`, above the `if (isPending)` guard:

```tsx
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSession();
  const invalidate = useInvalidateSession();

  // The cart is keyed by userId server-side — there is no anonymous cart to fill. Send the
  // visitor to sign in and bring them back here, rather than hiding the button and making the
  // catalogue read as a brochure.
  async function add(productId: string) {
    if (!session.data?.authenticated) {
      navigate("/login", { state: { from: location.pathname } });
      return;
    }
    await addItem(productId, 1);
    await invalidate();
  }
```

And below `<Price minorUnits={data.price} />` in the returned JSX:

```tsx
        <div>
          <Button onClick={() => void add(data.id)}>Add to cart</Button>
        </div>
```

- [ ] **Step 4: Run, typecheck, lint, format and commit**

```bash
pnpm vitest run --project @ecom/web
pnpm typecheck && pnpm lint && pnpm format:check
git add apps/web/src/routes/Product.tsx apps/web/src/routes/__tests__/Product.test.tsx
git commit -m "feat(web): add to cart, gated behind a session with a return-to"
```

---

### Task 7: Checkout and the order confirmation

**Files:**
- Create: `apps/web/src/api/orders.ts`, `apps/web/src/routes/Order.tsx`
- Create: `apps/web/src/routes/__tests__/Order.test.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `PlacedOrderSchema`, `OrderDetailSchema` (Task 1); `request` (Task 2).
- Produces: `placeOrder()`, `getOrder(id)`, `describeCheckoutFailure(e)`, `<Order>`.

- [ ] **Step 1: Write the order resource module**

`apps/web/src/api/orders.ts`:

```ts
import { OrderDetailSchema, PlacedOrderSchema } from "@ecom/contracts";
import { request } from "./request";
import { API } from "./refresh";
import { HttpError } from "./errors";

// POST takes no body: the server places whatever is in the caller's cart, prices it from its
// own read-model, and clears the cart in the same transaction.
export const placeOrder = () =>
  request(`${API}/orders`, PlacedOrderSchema, { method: "POST" });

export const getOrder = (id: string) =>
  request(`${API}/orders/${encodeURIComponent(id)}`, OrderDetailSchema);

// Two of the three failures are ordinary and recoverable in one click. Rendering them as
// "something went wrong" would strand a user who could have fixed it.
export function describeCheckoutFailure(e: unknown): string {
  if (e instanceof HttpError && e.status === 400)
    return "Your cart is empty — it may have been placed in another tab.";
  if (e instanceof HttpError && e.status === 422)
    return "One of these products has no price yet. Remove it and try again.";
  return "Could not place the order. Try again.";
}
```

- [ ] **Step 2: Write the failing confirmation test**

`apps/web/src/routes/__tests__/Order.test.tsx`:

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { makeQueryClient } from "../../api/queryClient";
import { HttpError } from "../../api/errors";
import * as ordersApi from "../../api/orders";
import * as productsApi from "../../api/products";
import { Order } from "../Order";

function renderAt(id: string) {
  const router = createMemoryRouter([{ path: "/orders/:id", element: <Order /> }], {
    initialEntries: [`/orders/${id}`],
  });
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
const detail = (over = {}) => ({
  id: "o1",
  userId: "u1",
  status: "PENDING" as const,
  totalPrice: 1800,
  items: [{ productId: "p1", quantity: 2, unitPrice: 900 }],
  createdAt: "2026-08-03T00:00:00.000Z",
  ...over,
});
afterEach(() => vi.restoreAllMocks());

it("shows the captured unit price, the total and the status", async () => {
  vi.spyOn(ordersApi, "getOrder").mockResolvedValue(detail());
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([
    { id: "p1", type: "ELECTRONICS", name: "Widget", price: 950, version: 2 },
  ]);
  renderAt("o1");
  expect(await screen.findByText("Widget")).toBeInTheDocument();
  // 900 is what the order captured; the catalogue now says 950. The order wins.
  expect(screen.getByText("$9.00")).toBeInTheDocument();
  expect(screen.getByText("$18.00")).toBeInTheDocument();
  expect(screen.getByText("PENDING")).toBeInTheDocument();
});

it("degrades to the id for a product the catalogue no longer has", async () => {
  vi.spyOn(ordersApi, "getOrder").mockResolvedValue(detail());
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([]);
  renderAt("o1");
  expect(await screen.findByText("p1")).toBeInTheDocument();
});

it("renders a not-found view for someone else's order", async () => {
  vi.spyOn(ordersApi, "getOrder").mockRejectedValue(new HttpError(404));
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([]);
  renderAt("nope");
  expect(await screen.findByText(/not found/i)).toBeInTheDocument();
});
```

- [ ] **Step 3: Run and confirm it fails**

Run: `pnpm vitest run apps/web/src/routes/__tests__/Order.test.tsx`
Expected: FAIL — cannot resolve `../Order`.

- [ ] **Step 4: Implement the confirmation**

`apps/web/src/routes/Order.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { HttpError } from "../api/errors";
import { getOrder } from "../api/orders";
import { listProducts } from "../api/products";
import { Badge } from "../components/Badge";
import { ErrorState } from "../components/ErrorState";
import { Price } from "../components/Price";
import { Skeleton } from "../components/Skeleton";

export function Order() {
  const { id = "" } = useParams();
  const order = useQuery({ queryKey: ["order", id], queryFn: () => getOrder(id) });
  const products = useQuery({ queryKey: ["products"], queryFn: listProducts });

  if (order.isPending) return <Skeleton />;
  if (order.error instanceof HttpError && order.error.status === 404) {
    return (
      <div className="p-12 text-center">
        <h1 className="text-2xl">Order not found</h1>
        <Link to="/" className="datum mt-4 inline-block underline">
          Back to the catalogue
        </Link>
      </div>
    );
  }
  if (order.error) return <ErrorState error={order.error} />;

  // Names come from the catalogue, prices do NOT: an order carries the price it captured, and
  // an order outlives the product it references.
  const byId = new Map((products.data ?? []).map((p) => [p.id, p]));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl">Order placed</h1>
        <Badge>{order.data.status}</Badge>
      </div>
      <ul className="flex flex-col gap-2">
        {order.data.items.map((i) => (
          <li
            key={i.productId}
            className="flex justify-between border-b border-[color:var(--color-line)] py-2"
          >
            <span>
              {byId.get(i.productId)?.name ?? i.productId}
              <span className="datum ml-2 text-[color:var(--color-muted)]">
                × {i.quantity}
              </span>
            </span>
            <Price minorUnits={i.unitPrice} />
          </li>
        ))}
      </ul>
      <p className="flex justify-between">
        <span className="datum text-xs uppercase text-[color:var(--color-muted)]">Total</span>
        <Price minorUnits={order.data.totalPrice} />
      </p>
      <Link to="/" className="datum underline">
        Continue shopping
      </Link>
    </div>
  );
}
```

- [ ] **Step 5: Add the route, guarded**

In `apps/web/src/App.tsx`, add to the layout's `children`:

```tsx
      {
        path: "/orders/:id",
        element: (
          <RequireAuth>
            <Order />
          </RequireAuth>
        ),
      },
```

- [ ] **Step 6: Add the checkout button to the cart**

In `apps/web/src/routes/Cart.tsx`, add these imports:

```tsx
import { useState } from "react";
import { useNavigate } from "react-router";
import { describeCheckoutFailure, placeOrder } from "../api/orders";
import { Button } from "../components/Button";
```

Add `const navigate = useNavigate();` and
`const [checkoutError, setCheckoutError] = useState<string | null>(null);` beside the existing
hooks — **above** the `if (session.isPending …)` early return, since hooks must not sit behind
a conditional. Then add the handler next to `change`:

```tsx
  async function checkout() {
    setCheckoutError(null);
    try {
      const placed = await placeOrder();
      // POST /orders clears the cart inside the same transaction that writes the order, so
      // the badge is stale the moment this returns.
      await invalidate();
      navigate(`/orders/${placed.orderId}`);
    } catch (e) {
      setCheckoutError(describeCheckoutFailure(e));
    }
  }
```

And below the estimate paragraph in the returned JSX:

```tsx
      {checkoutError ? (
        <p role="alert" className="text-sm text-[color:var(--color-fail)]">
          {checkoutError}
        </p>
      ) : null}
      <Button onClick={() => void checkout()}>Place order</Button>
```

- [ ] **Step 7: Add the checkout failure tests to the cart suite**

Append to `apps/web/src/routes/__tests__/Cart.test.tsx` (import `HttpError` from
`../../api/errors` and `* as ordersApi from "../../api/orders"`):

```tsx
it.each([
  [400, /cart is empty/i],
  [422, /no price yet/i],
])("explains a %i from checkout instead of a generic error", async (status, pattern) => {
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [{ productId: "p1", quantity: 1 }] },
  });
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([product()]);
  vi.spyOn(ordersApi, "placeOrder").mockRejectedValue(new HttpError(status));
  renderCart();
  await screen.findByText("Widget");
  fireEvent.click(screen.getByRole("button", { name: /place order/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(pattern);
});
```

- [ ] **Step 8: Run, typecheck, lint, format and commit**

```bash
pnpm vitest run --project @ecom/web
pnpm typecheck && pnpm lint && pnpm format:check && pnpm -r build
git add apps/web/src
git commit -m "feat(web): checkout with real recovery paths and an order confirmation"
```

---

### Task 8: Real-stack verification and documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md`
- Create: `.scratch/phase-8b/browser-pass.md`

- [ ] **Step 1: Bring the stack up**

```bash
docker compose up -d postgres kafka rabbitmq redis
docker start ecom-platform-identity-1 ecom-platform-order-1 ecom-platform-catalog-1 \
  ecom-platform-inventory-1 ecom-platform-payment-1 ecom-platform-notification-1 \
  ecom-platform-gateway-1
pnpm --filter @ecom/web dev
```

- [ ] **Step 2: Walk the flows in a browser and record what you see**

8a's two worst defects passed typecheck, lint, format and 27 green jsdom tests: a page that
served raw JSON, and a permanently-dark palette. Neither was reachable from a test. Walk these
and write the result to `.scratch/phase-8b/browser-pass.md`:

1. **Anonymous load of `/`** — the catalogue renders, the header shows "Sign in", and the
   network panel shows **no `POST /api/auth/refresh`** and no redirect. This is §A1's blocker.
2. **Add to cart while logged out** — lands on `/login`, and after signing in returns to the
   product.
3. **Register** — lands on the sign-in form with the email prefilled.
4. **Register the same email twice** — the message appears on the email field.
5. **Add two products, change a quantity, remove one** — the header badge tracks each change.
6. **Place the order** — lands on the confirmation, the badge drops to 0, and the DevTools
   network panel shows `X-CSRF-Token` on `POST /api/orders`.
7. **Reload the confirmation URL directly** — it renders the app, not JSON.
8. **Application → Cookies** — `access_token` and `refresh_token` are `HttpOnly`, `XSRF-TOKEN`
   is not.

- [ ] **Step 3: Amend the roadmap's 8b line**

In §Phase 8 Slices, replace slice 2:

```markdown
2. **8b — Auth + cart + checkout:** cookie login/register through the gateway (register
   returns no tokens, so it lands on a prefilled sign-in), CSRF on every mutation, protected
   routes with a return-to, the server cart joined against the catalogue for names, and place
   order. The session is derived from `GET /cart`, not from the readable CSRF cookie. Frontend
   only — no service production code changed.
```

- [ ] **Step 4: Full gate and commit**

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm -r build
pnpm vitest run --project @ecom/web --project packages
git add docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md
git commit -m "docs(8b): record the storefront auth and checkout slice"
```

---

## Notes for the executor

- **Global Constraint 1 is not negotiable.** If a task appears to need a service change, stop
  and report it rather than editing a service.
- **Every RED step must fail for the stated reason.** A test that fails because a module is
  missing has not yet proven the behaviour it describes. Task 2 Step 11 and Task 1 Step 6 make
  this explicit because those two tests are the alarms the slice rests on.
- **Tasks are ordered and each is green on its own commit.** Task 5 ships the cart without a
  checkout button precisely so it imports nothing Task 7 has not written yet; Task 7 adds the
  button back. Do not merge the two.
- **Keep the API layer acyclic.** `csrf → refresh → request → cart → session` is a straight
  line, and `session.ts` is imported by hooks and routes but never by the modules beneath it.
  ESM would tolerate a cycle here right up until module-init order changed under it.
- Only Task 8 needs the full stack. Everything else runs offline.
- Deviations go in `.scratch/phase-8b/impl-notes.html` and in the final digest's
  `Deviations:` section.
