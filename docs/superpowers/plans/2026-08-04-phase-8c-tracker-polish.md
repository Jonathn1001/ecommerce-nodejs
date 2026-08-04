# Phase 8c — Order-pipeline tracker + polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the checkout saga visible — a live order tracker fed by SSE with a terminating polling fallback — and finish the storefront with order history, an accessibility pass, local e2e, and a packaged production build.

**Architecture:** The stream writes into the React Query cache, so the page keeps one source of truth and the fallback is a flag on the same query. The four tracker steps are derived from the four `Order` statuses by one pure module. The Order service gains a list endpoint; the gateway is untouched.

**Tech Stack:** React 19 + TanStack Query 5 + React Router 8 + Tailwind 4 (`apps/web`), Express + Prisma (`services/order`), zod contracts consumed as TypeScript source, Vitest (jsdom project) + Playwright, nginx for packaging.

**Spec:** `docs/superpowers/specs/2026-08-04-phase-8c-tracker-polish-design.md` — read it before Task 1. Section references below (§A1, §B2, …) point into it.

## Global Constraints

- Every task ends green on `pnpm typecheck`, `pnpm lint`, `pnpm format:check` — **lint included**, per 7c's lesson that CI caught lint errors no task check would.
- Run tests from the repo root: `pnpm vitest run <path>`. The root `vitest.workspace.ts` gives `apps/web` its own jsdom project; the node projects must never inherit it.
- Web tests live at `src/**/__tests__/<name>.test.ts(x)` — the glob in `apps/web/vitest.config.ts` is `src/**/*.test.{ts,tsx}`.
- Integration tests that touch Postgres tag the rows they seed and delete them by DB query in `afterAll` (7d convention — see `services/order/src/__tests__/ownership.int.test.ts`).
- Never commit `docker-compose.yml`, `.env*`, or anything under a config directory. Only `*.example.yml` files are committed.
- Commit specific files. Never `git add -A`.
- `POLL_INTERVAL_MS = 3000`, `MAX_STREAM_ERRORS = 3`, `ORDER_LIST_LIMIT = 50` — named constants, never literals at call sites.
- The browser only ever calls same-origin `/api/*`. No gateway host in the bundle.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `packages/contracts/src/http/order.ts` | `OrderSummarySchema`, `OrderListSchema`; cart schemas become strict | 1, 11 |
| `services/order/src/app.ts` | `GET /orders` (list, caller-scoped, capped) | 1 |
| `services/order/src/__tests__/order-list.int.test.ts` | proves scoping, ordering, cap, `itemCount` | 1 |
| `apps/web/src/api/errors.ts` | `HttpError` carries an optional parsed body | 2 |
| `apps/web/src/api/request.ts` | best-effort error-body read | 2 |
| `apps/web/src/api/orders.ts` | `listOrders()`; `describeCheckoutFailure` names the product | 2, 7 |
| `apps/web/src/order/saga-steps.ts` | the ONLY module that knows what a status implies | 3 |
| `apps/web/src/api/stream.ts` | EventSource wrapper: named `status` events, injectable factory | 4 |
| `apps/web/src/hooks/useOrderStream.ts` | the fallback ladder and the cache writes | 5 |
| `apps/web/src/components/OrderTracker.tsx` | presentational pipeline | 6 |
| `apps/web/src/routes/Order.tsx` | wires tracker + stream into the detail page | 6 |
| `apps/web/src/routes/Orders.tsx` | order history | 7 |
| `apps/web/src/components/Layout.tsx` | skip link, history nav link | 7, 8 |
| `apps/web/playwright.config.ts`, `apps/web/e2e/*.spec.ts` | three local walks | 9 |
| `apps/web/Dockerfile`, `apps/web/nginx.conf`, `docker-compose.prod.example.yml` | packaging | 10 |
| `services/order/src/metrics.ts` | `SAGA_BUCKETS` boundaries near 1.5s and 2s | 11 |

---

### Task 1: `GET /orders` and the summary contract

**Files:**

- Modify: `packages/contracts/src/http/order.ts`
- Modify: `services/order/src/app.ts` (add a route beside `GET /orders/:id` at :183)
- Test: `services/order/src/__tests__/order-list.int.test.ts` (create)

**Interfaces:**

- Produces: `OrderSummarySchema`, `OrderListSchema`, `type OrderSummary` from `@ecom/contracts`; `GET /orders` → `200` array of `{id, status, totalPrice, itemCount, createdAt}`, `400` without `x-user-id`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing integration test**

Create `services/order/src/__tests__/order-list.int.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import { OrderListSchema } from "@ecom/contracts";
import { createApp } from "../app";
import { prisma } from "../db";

const app = createApp();

// Tagged so afterAll can delete by query rather than an in-memory id list (7d convention).
const TEST_TAG = "test-order-list-int";
const tagged = () => `${TEST_TAG}-${randomUUID()}`;

async function seedOrder(userId: string, lines: number, createdAt: Date) {
  return prisma.order.create({
    data: {
      userId,
      status: "PENDING",
      totalPrice: 100 * lines,
      createdAt,
      items: {
        create: Array.from({ length: lines }, () => ({
          productId: `p_${randomUUID()}`,
          quantity: 1,
          unitPrice: 100,
        })),
      },
    },
  });
}

describe("order list (integration — needs compose up + migrated)", () => {
  afterAll(async () => {
    const seeded = await prisma.order.findMany({
      where: { userId: { startsWith: TEST_TAG } },
      select: { id: true },
    });
    const ids = seeded.map((o) => o.id);
    if (ids.length > 0) {
      await prisma.outbox.deleteMany({ where: { aggregateId: { in: ids } } });
      await prisma.order.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.$disconnect();
  });

  it("returns only the caller's orders, newest first, with a line count", async () => {
    const mine = tagged();
    const theirs = tagged();
    const older = await seedOrder(mine, 1, new Date("2026-08-01T00:00:00.000Z"));
    const newer = await seedOrder(mine, 3, new Date("2026-08-02T00:00:00.000Z"));
    await seedOrder(theirs, 2, new Date("2026-08-03T00:00:00.000Z"));

    const res = await request(app).get("/orders").set("x-user-id", mine);

    expect(res.status).toBe(200);
    const parsed = OrderListSchema.parse(res.body);
    expect(parsed.map((o) => o.id)).toEqual([newer.id, older.id]);
    expect(parsed[0].itemCount).toBe(3);
    expect(parsed[1].itemCount).toBe(1);
  });

  it("caps the list at 50", async () => {
    const many = tagged();
    for (let i = 0; i < 51; i++) {
      await seedOrder(many, 1, new Date(2026, 0, 1, 0, 0, i));
    }
    const res = await request(app).get("/orders").set("x-user-id", many);
    expect(res.body).toHaveLength(50);
  });

  it("rejects a request with no caller", async () => {
    const res = await request(app).get("/orders");
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run services/order/src/__tests__/order-list.int.test.ts`
Expected: FAIL — `GET /orders` currently falls through to a 404, so `res.status` is 404 and `OrderListSchema` is not exported yet.

- [ ] **Step 3: Add the contract**

In `packages/contracts/src/http/order.ts`, below `OrderDetailSchema`:

```ts
// The history row. `itemCount` instead of the lines themselves: a list of 50 orders does not
// need every line, and the detail endpoint already serves them.
export const OrderSummarySchema = z.object({
  id: z.string(),
  status: OrderStatusSchema,
  totalPrice: z.number().int(),
  itemCount: z.number().int(),
  createdAt: z.string(),
});
export type OrderSummary = z.infer<typeof OrderSummarySchema>;

export const OrderListSchema = z.array(OrderSummarySchema);
export type OrderList = z.infer<typeof OrderListSchema>;
```

- [ ] **Step 4: Add the route**

In `services/order/src/app.ts`, immediately **before** `app.get("/orders/:id", …)` (:183):

```ts
// Caller-scoped history. Capped rather than paginated: a documented ceiling beats half a
// pagination, and widening it later with a cursor is additive (spec §D2).
const ORDER_LIST_LIMIT = 50;
app.get("/orders", async (req, res) => {
  const userId = userIdOf(req);
  if (!userId) return res.status(400).json({ error: "missing x-user-id" });
  try {
    const orders = await prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: ORDER_LIST_LIMIT,
      include: { _count: { select: { items: true } } },
    });
    res.json(
      orders.map((o) => ({
        id: o.id,
        status: o.status,
        totalPrice: o.totalPrice,
        itemCount: o._count.items,
        createdAt: o.createdAt.toISOString(),
      }))
    );
  } catch {
    log.error("order_list_failed", { traceId: req.traceId });
    res.status(500).json({ error: "internal error" });
  }
});
```

- [ ] **Step 5: Run the test again**

Run: `pnpm vitest run services/order/src/__tests__/order-list.int.test.ts`
Expected: PASS, 3 tests. If the DB is not up: `docker compose up -d` and re-run.

- [ ] **Step 6: Prove the gateway needs no change**

Run: `grep -n "RULES" services/gateway/src/authz.ts` and confirm `GET /orders` matches no rule, then `grep -n 'app.use("/orders"' services/gateway/src/app.ts` and confirm the mount exists. Record both in the task report. **No gateway file is edited in this task** — if you find yourself editing one, stop and re-read spec §D1.

- [ ] **Step 7: Gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm format:check
git add packages/contracts/src/http/order.ts services/order/src/app.ts services/order/src/__tests__/order-list.int.test.ts
git commit -m "feat(order): caller-scoped order history, capped at 50"
```

---

### Task 2: `HttpError` carries a body, and checkout names the product

**Files:**

- Modify: `apps/web/src/api/errors.ts`
- Modify: `apps/web/src/api/request.ts`
- Modify: `apps/web/src/api/orders.ts`
- Modify: `apps/web/src/routes/Cart.tsx` (call sites at :79 and :82)
- Test: `apps/web/src/api/__tests__/request.test.ts` (extend), `apps/web/src/api/__tests__/orders.test.ts` (create)

**Interfaces:**

- Produces: `new HttpError(status, body?)` with `readonly body?: unknown`; `describeCheckoutFailure(e: unknown, nameFor?: (id: string) => string | undefined): string`.
- Consumes: nothing from Task 1.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/api/__tests__/request.test.ts`:

```ts
it("attaches a JSON error body to HttpError", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ error: "unpriced", productId: "p9" }), {
      status: 422,
      headers: { "content-type": "application/json" },
    })
  );
  await expect(request("/api/orders", z.unknown(), { method: "POST" })).rejects.toMatchObject({
    status: 422,
    body: { productId: "p9" },
  });
});

it("leaves body undefined when the error payload is not JSON", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("<html>502</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    })
  );
  await expect(request("/api/orders", z.unknown())).rejects.toMatchObject({
    status: 502,
    body: undefined,
  });
});
```

The POST case needs an `XSRF-TOKEN` cookie; follow the cookie setup already used in that file.

Create `apps/web/src/api/__tests__/orders.test.ts`:

```ts
import { describeCheckoutFailure } from "../orders";
import { HttpError } from "../errors";

it("names the unpriced product when the 422 body says which", () => {
  const e = new HttpError(422, { error: "unpriced", productId: "p9" });
  expect(describeCheckoutFailure(e, (id) => (id === "p9" ? "Widget" : undefined))).toContain(
    "Widget"
  );
});

it("falls back to a generic message when the body names no product", () => {
  const e = new HttpError(422, {});
  expect(describeCheckoutFailure(e, () => undefined)).toMatch(/no price/i);
});

it("still explains an empty cart", () => {
  expect(describeCheckoutFailure(new HttpError(400))).toMatch(/empty/i);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run apps/web/src/api/__tests__/request.test.ts apps/web/src/api/__tests__/orders.test.ts`
Expected: FAIL — `HttpError` takes one argument, and `describeCheckoutFailure` takes one parameter.

- [ ] **Step 3: Widen `HttpError`**

In `apps/web/src/api/errors.ts`:

```ts
export class HttpError extends Error {
  constructor(
    readonly status: number,
    // Parsed only when the response declared JSON, and only on a best-effort basis: a
    // truncated or non-JSON error payload must not turn one failure into two. Everything
    // still branches on `status`; `body` only ever adds detail to a message.
    readonly body?: unknown
  ) {
    super(`the gateway answered ${status}`);
    this.name = "HttpError";
  }
}
```

- [ ] **Step 4: Read the body in `request()`**

In `apps/web/src/api/request.ts`, replace `if (!res.ok) throw new HttpError(res.status);` with:

```ts
if (!res.ok) throw new HttpError(res.status, await readErrorBody(res));
```

and add above `request`:

```ts
async function readErrorBody(res: Response): Promise<unknown> {
  if (!res.headers.get("content-type")?.includes("application/json")) return undefined;
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 5: Name the product**

In `apps/web/src/api/orders.ts`:

```ts
export const listOrders = () => request(`${API}/orders`, OrderListSchema);

// Order puts the offending productId in its 422 body; before 8c that detail was thrown away
// with the body itself, so this said "one of these products" about a specific one.
export function describeCheckoutFailure(
  e: unknown,
  nameFor: (id: string) => string | undefined = () => undefined
): string {
  if (e instanceof HttpError && e.status === 400)
    return "Your cart is empty — it may have been placed in another tab.";
  if (e instanceof HttpError && e.status === 422) {
    const id =
      typeof e.body === "object" && e.body !== null && "productId" in e.body
        ? String((e.body as { productId: unknown }).productId)
        : undefined;
    const name = id ? nameFor(id) : undefined;
    return name
      ? `${name} has no price yet. Remove it and try again.`
      : "One of these products has no price yet. Remove it and try again.";
  }
  return "Could not place the order. Try again.";
}
```

Import `OrderListSchema` alongside the existing contract imports.

- [ ] **Step 6: Pass the lookup at the call sites**

In `apps/web/src/routes/Cart.tsx`, both calls become:

```tsx
setCheckoutError(describeCheckoutFailure(e, (id) => byId.get(id)?.name));
```

`byId` is already in scope (built at :30).

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run apps/web/src/api apps/web/src/routes/__tests__/Cart.test.tsx`
Expected: PASS, no regression in the existing cart suite.

- [ ] **Step 8: Gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm format:check
git add apps/web/src/api/errors.ts apps/web/src/api/request.ts apps/web/src/api/orders.ts apps/web/src/routes/Cart.tsx apps/web/src/api/__tests__/request.test.ts apps/web/src/api/__tests__/orders.test.ts
git commit -m "feat(web): error bodies reach the message that needed them"
```

---

### Task 3: `saga-steps` — the only module that knows what a status implies

**Files:**

- Create: `apps/web/src/order/saga-steps.ts`
- Test: `apps/web/src/order/__tests__/saga-steps.test.ts`

**Interfaces:**

- Produces:
  ```ts
  type StepKey = "placed" | "reserved" | "payment" | "confirmed";
  type StepState = "done" | "active" | "failed" | "pending";
  type Step = { key: StepKey; label: string; state: StepState };
  type FailedAt = "PENDING" | "AWAITING_PAYMENT" | null;
  function stepsFor(status: OrderStatus, failedAt?: FailedAt): Step[];
  ```
- Consumes: `OrderStatus` from `@ecom/contracts`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/order/__tests__/saga-steps.test.ts`:

```ts
import { stepsFor } from "../saga-steps";

const stateOf = (status: Parameters<typeof stepsFor>[0], failedAt?: "PENDING" | "AWAITING_PAYMENT") =>
  Object.fromEntries(stepsFor(status, failedAt ?? null).map((s) => [s.key, s.state]));

it("PENDING means placed, and the reservation is in flight", () => {
  expect(stateOf("PENDING")).toEqual({
    placed: "done",
    reserved: "active",
    payment: "pending",
    confirmed: "pending",
  });
});

// The whole basis of the tracker: an order cannot reach AWAITING_PAYMENT unless the
// reservation succeeded (services/order/src/transition.ts:14).
it("AWAITING_PAYMENT proves the reservation succeeded", () => {
  expect(stateOf("AWAITING_PAYMENT")).toEqual({
    placed: "done",
    reserved: "done",
    payment: "active",
    confirmed: "pending",
  });
});

it("CONFIRMED completes every step", () => {
  expect(stateOf("CONFIRMED")).toEqual({
    placed: "done",
    reserved: "done",
    payment: "done",
    confirmed: "done",
  });
});

it("a cancellation observed during PENDING failed at the reservation", () => {
  expect(stateOf("CANCELLED", "PENDING")).toEqual({
    placed: "done",
    reserved: "failed",
    payment: "pending",
    confirmed: "pending",
  });
});

it("a cancellation observed during AWAITING_PAYMENT failed at the payment", () => {
  expect(stateOf("CANCELLED", "AWAITING_PAYMENT")).toEqual({
    placed: "done",
    reserved: "done",
    payment: "failed",
    confirmed: "pending",
  });
});

// Cold load: the status alone cannot say which leg failed, so the tracker names none.
// Guessing "payment" would state a falsehood for every reservation-failed order.
it("a cold-loaded cancellation blames no step", () => {
  const states = stateOf("CANCELLED");
  expect(Object.values(states)).not.toContain("failed");
  expect(states.placed).toBe("done");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/web/src/order`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/web/src/order/saga-steps.ts`:

```ts
import type { OrderStatus } from "@ecom/contracts";

export type StepKey = "placed" | "reserved" | "payment" | "confirmed";
export type StepState = "done" | "active" | "failed" | "pending";
export type Step = { key: StepKey; label: string; state: StepState };

// The status the tracker last saw before a terminal CANCELLED arrived. Null when the page was
// loaded cold on an already-cancelled order — the one case where the failing leg is unknowable.
export type FailedAt = "PENDING" | "AWAITING_PAYMENT" | null;

const LABELS: Record<StepKey, string> = {
  placed: "Order placed",
  reserved: "Inventory reserved",
  payment: "Payment",
  confirmed: "Confirmed",
};

const ORDER: StepKey[] = ["placed", "reserved", "payment", "confirmed"];

// The choreographed saga has more transitions than Order has statuses, and this is the only
// module allowed to know how the two relate (spec §A1). Callers render what they are handed.
function statesFor(status: OrderStatus, failedAt: FailedAt): Record<StepKey, StepState> {
  switch (status) {
    case "PENDING":
      return { placed: "done", reserved: "active", payment: "pending", confirmed: "pending" };
    case "AWAITING_PAYMENT":
      return { placed: "done", reserved: "done", payment: "active", confirmed: "pending" };
    case "CONFIRMED":
      return { placed: "done", reserved: "done", payment: "done", confirmed: "done" };
    case "CANCELLED":
      if (failedAt === "PENDING")
        return { placed: "done", reserved: "failed", payment: "pending", confirmed: "pending" };
      if (failedAt === "AWAITING_PAYMENT")
        return { placed: "done", reserved: "done", payment: "failed", confirmed: "pending" };
      return { placed: "done", reserved: "pending", payment: "pending", confirmed: "pending" };
  }
}

export function stepsFor(status: OrderStatus, failedAt: FailedAt = null): Step[] {
  const states = statesFor(status, failedAt);
  return ORDER.map((key) => ({ key, label: LABELS[key], state: states[key] }));
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run apps/web/src/order`
Expected: PASS, 6 tests.

- [ ] **Step 5: Gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm format:check
git add apps/web/src/order/saga-steps.ts apps/web/src/order/__tests__/saga-steps.test.ts
git commit -m "feat(web): derive the saga's four steps from its four statuses"
```

---

### Task 4: `stream.ts` — a named SSE event behind an injectable factory

**Files:**

- Create: `apps/web/src/api/stream.ts`
- Test: `apps/web/src/api/__tests__/stream.test.ts`

**Interfaces:**

- Produces:
  ```ts
  type StatusFrame = { orderId: string; status: OrderStatus };
  type EventSourceLike = {
    addEventListener(type: string, fn: (e: { data?: string }) => void): void;
    close(): void;
  };
  type EventSourceFactory = (url: string) => EventSourceLike;
  function openOrderStream(
    orderId: string,
    handlers: { onFrame: (f: StatusFrame) => void; onError: () => void },
    opts?: { create?: EventSourceFactory }
  ): { close: () => void };
  ```
- Consumes: `OrderStatusSchema` from `@ecom/contracts`.

**Read first:** spec §B3. The service writes `event: status\ndata: {...}` (`services/order/src/app.ts:241`). `EventSource` routes a **named** event only to `addEventListener("status", …)`; `onmessage` fires for unnamed frames and would never fire here.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/api/__tests__/stream.test.ts`:

```ts
import { openOrderStream } from "../stream";

type Listener = (e: { data?: string }) => void;

// A fake that behaves like the real thing in the one way that matters: it delivers the
// service's frames as a NAMED "status" event. A fake that called onmessage instead would make
// every test here pass against a page that receives nothing.
function fakeEventSource() {
  const listeners = new Map<string, Listener[]>();
  let closed = false;
  const es = {
    addEventListener(type: string, fn: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    close() {
      closed = true;
    },
  };
  return {
    create: (_url: string) => es,
    emit: (type: string, data?: string) =>
      (listeners.get(type) ?? []).forEach((fn) => fn({ data })),
    isClosed: () => closed,
  };
}

// Captured by the factory wrapper in the URL test below.
let _seen = "";

it("delivers a named status frame", () => {
  const fake = fakeEventSource();
  const frames: unknown[] = [];
  openOrderStream("o1", { onFrame: (f) => frames.push(f), onError: () => {} }, {
    create: (url) => {
      _seen = url;
      return fake.create(url);
    },
  });
  fake.emit("status", JSON.stringify({ orderId: "o1", status: "AWAITING_PAYMENT" }));
  expect(frames).toEqual([{ orderId: "o1", status: "AWAITING_PAYMENT" }]);
});

it("subscribes same-origin under /api", () => {
  const fake = fakeEventSource();
  openOrderStream("o1", { onFrame: () => {}, onError: () => {} }, {
    create: (url) => {
      _seen = url;
      return fake.create(url);
    },
  });
  expect(_seen).toBe("/api/orders/o1/stream");
});

it("ignores a frame that is not a valid status", () => {
  const fake = fakeEventSource();
  const frames: unknown[] = [];
  openOrderStream("o1", { onFrame: (f) => frames.push(f), onError: () => {} }, {
    create: fake.create,
  });
  fake.emit("status", JSON.stringify({ orderId: "o1", status: "WAT" }));
  fake.emit("status", "not json at all");
  expect(frames).toEqual([]);
});

it("reports errors and closes on demand", () => {
  const fake = fakeEventSource();
  let errors = 0;
  const handle = openOrderStream("o1", { onFrame: () => {}, onError: () => errors++ }, {
    create: fake.create,
  });
  fake.emit("error");
  handle.close();
  expect(errors).toBe(1);
  expect(fake.isClosed()).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/web/src/api/__tests__/stream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/web/src/api/stream.ts`:

```ts
import { OrderStatusSchema } from "@ecom/contracts";
import type { OrderStatus } from "@ecom/contracts";
import { z } from "zod";

export type StatusFrame = { orderId: string; status: OrderStatus };

const FrameSchema = z.object({ orderId: z.string(), status: OrderStatusSchema });

// Structural, not `EventSource`: the constructor is undefined in the test environment (jsdom
// does not implement it and Node 22 has no global), so the type cannot come from the DOM lib
// at runtime and the factory must be injectable.
export type EventSourceLike = {
  addEventListener(type: string, fn: (e: { data?: string }) => void): void;
  close(): void;
};
export type EventSourceFactory = (url: string) => EventSourceLike;

const defaultCreate: EventSourceFactory = (url) =>
  new EventSource(url) as unknown as EventSourceLike;

export function openOrderStream(
  orderId: string,
  handlers: { onFrame: (f: StatusFrame) => void; onError: () => void },
  opts: { create?: EventSourceFactory } = {}
): { close: () => void } {
  const create = opts.create ?? defaultCreate;
  // Same-origin under /api, so the session cookie rides automatically — EventSource cannot
  // set headers, which is why the gateway authenticates this stream from the cookie.
  const es = create(`/api/orders/${encodeURIComponent(orderId)}/stream`);

  // NAMED event. The service writes `event: status`, and onmessage would never fire.
  es.addEventListener("status", (e) => {
    let raw: unknown;
    try {
      raw = JSON.parse(e.data ?? "");
    } catch {
      return;
    }
    const parsed = FrameSchema.safeParse(raw);
    // A frame that does not match the contract is dropped rather than thrown: the stream is a
    // progress indicator, and the query underneath it remains the authority.
    if (parsed.success) handlers.onFrame(parsed.data);
  });

  es.addEventListener("error", () => handlers.onError());

  return { close: () => es.close() };
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run apps/web/src/api/__tests__/stream.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Prove the test can fail**

Temporarily change `addEventListener("status", …)` to `addEventListener("message", …)`, re-run, and confirm the first test FAILS. Revert. Record the observation in the task report — this is the mutation check the spec asks for (§B3).

- [ ] **Step 6: Gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm format:check
git add apps/web/src/api/stream.ts apps/web/src/api/__tests__/stream.test.ts
git commit -m "feat(web): SSE frames, read as the named event they are"
```

---

### Task 5: `useOrderStream` — the ladder and the cache writes

**Files:**

- Create: `apps/web/src/hooks/useOrderStream.ts`
- Test: `apps/web/src/hooks/__tests__/useOrderStream.test.tsx`

**Interfaces:**

- Consumes: `openOrderStream`, `EventSourceFactory` (Task 4); `FailedAt` (Task 3); `refreshSession` from `../api/refresh`.
- Produces:
  ```ts
  const POLL_INTERVAL_MS = 3000;
  const MAX_STREAM_ERRORS = 3;
  function useOrderStream(
    orderId: string,
    opts?: { create?: EventSourceFactory }
  ): { polling: boolean; failedAt: FailedAt };
  ```

**Read first:** spec §B1 and §B2. Rung 1 **closes, refreshes, reopens** — leaving the stream open lets its own ~3s reconnect race the refresh.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/hooks/__tests__/useOrderStream.test.tsx`:

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, act } from "@testing-library/react";
import { makeQueryClient } from "../../api/queryClient";
import * as refreshApi from "../../api/refresh";
import { useOrderStream } from "../useOrderStream";

type Listener = (e: { data?: string }) => void;

function harness() {
  const instances: Array<{ listeners: Map<string, Listener[]>; closed: boolean }> = [];
  const create = () => {
    const inst = { listeners: new Map<string, Listener[]>(), closed: false };
    instances.push(inst);
    return {
      addEventListener(type: string, fn: Listener) {
        inst.listeners.set(type, [...(inst.listeners.get(type) ?? []), fn]);
      },
      close() {
        inst.closed = true;
      },
    };
  };
  const emit = (i: number, type: string, data?: string) =>
    (instances[i].listeners.get(type) ?? []).forEach((fn) => fn({ data }));
  return { create, emit, instances };
}

const wrapper = (client = makeQueryClient()) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };

afterEach(() => vi.restoreAllMocks());

it("advances an existing cached order and never creates one", async () => {
  const client = makeQueryClient();
  const h = harness();
  client.setQueryData(["order", "o1"], {
    id: "o1",
    userId: "u1",
    status: "PENDING",
    totalPrice: 100,
    items: [{ productId: "p1", quantity: 1, unitPrice: 100 }],
    createdAt: "2026-08-04T00:00:00.000Z",
  });
  renderHook(() => useOrderStream("o1", { create: h.create }), { wrapper: wrapper(client) });
  act(() => h.emit(0, "status", JSON.stringify({ orderId: "o1", status: "AWAITING_PAYMENT" })));
  await waitFor(() =>
    expect((client.getQueryData(["order", "o1"]) as { status: string }).status).toBe(
      "AWAITING_PAYMENT"
    )
  );
});

it("drops a frame that arrives before the order is cached", async () => {
  const client = makeQueryClient();
  const h = harness();
  renderHook(() => useOrderStream("o1", { create: h.create }), { wrapper: wrapper(client) });
  act(() => h.emit(0, "status", JSON.stringify({ orderId: "o1", status: "CONFIRMED" })));
  expect(client.getQueryData(["order", "o1"])).toBeUndefined();
});

it("closes, refreshes once, and reopens on the first error", async () => {
  const h = harness();
  const refresh = vi.spyOn(refreshApi, "refreshSession").mockResolvedValue(true);
  renderHook(() => useOrderStream("o1", { create: h.create }), { wrapper: wrapper() });
  act(() => h.emit(0, "error"));
  await waitFor(() => expect(h.instances).toHaveLength(2));
  expect(h.instances[0].closed).toBe(true);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("falls back to polling on the third error and not before", async () => {
  const h = harness();
  vi.spyOn(refreshApi, "refreshSession").mockResolvedValue(true);
  const { result } = renderHook(() => useOrderStream("o1", { create: h.create }), {
    wrapper: wrapper(),
  });
  act(() => h.emit(0, "error"));
  await waitFor(() => expect(h.instances).toHaveLength(2));
  act(() => h.emit(1, "error"));
  expect(result.current.polling).toBe(false);
  act(() => h.emit(1, "error"));
  await waitFor(() => expect(result.current.polling).toBe(true));
  expect(h.instances[1].closed).toBe(true);
});

it("remembers the status it was in when a cancellation arrived", async () => {
  const client = makeQueryClient();
  const h = harness();
  client.setQueryData(["order", "o1"], { id: "o1", status: "PENDING", items: [] });
  const { result } = renderHook(() => useOrderStream("o1", { create: h.create }), {
    wrapper: wrapper(client),
  });
  act(() => h.emit(0, "status", JSON.stringify({ orderId: "o1", status: "AWAITING_PAYMENT" })));
  act(() => h.emit(0, "status", JSON.stringify({ orderId: "o1", status: "CANCELLED" })));
  await waitFor(() => expect(result.current.failedAt).toBe("AWAITING_PAYMENT"));
});

it("stops everything on a terminal frame", async () => {
  const h = harness();
  const { result } = renderHook(() => useOrderStream("o1", { create: h.create }), {
    wrapper: wrapper(),
  });
  act(() => h.emit(0, "status", JSON.stringify({ orderId: "o1", status: "CONFIRMED" })));
  await waitFor(() => expect(h.instances[0].closed).toBe(true));
  expect(result.current.polling).toBe(false);
});

it("closes the stream on unmount", () => {
  const h = harness();
  const { unmount } = renderHook(() => useOrderStream("o1", { create: h.create }), {
    wrapper: wrapper(),
  });
  unmount();
  expect(h.instances[0].closed).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/web/src/hooks`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/web/src/hooks/useOrderStream.ts`:

```ts
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { OrderDetail, OrderStatus } from "@ecom/contracts";
import { openOrderStream, type EventSourceFactory } from "../api/stream";
import { refreshSession } from "../api/refresh";
import type { FailedAt } from "../order/saga-steps";

// Chosen against the saga_duration p(99)<5000 threshold in k6/checkout.js:21.
export const POLL_INTERVAL_MS = 3000;
export const MAX_STREAM_ERRORS = 3;

const isTerminal = (s: OrderStatus) => s === "CONFIRMED" || s === "CANCELLED";

export function useOrderStream(
  orderId: string,
  opts: { create?: EventSourceFactory } = {}
): { polling: boolean; failedAt: FailedAt } {
  const qc = useQueryClient();
  const [polling, setPolling] = useState(false);
  const [failedAt, setFailedAt] = useState<FailedAt>(null);
  const create = opts.create;

  // Refs, not state: the ladder must not re-render the page, and a stale closure over the
  // error count would let a burst of errors each read zero.
  const lastStatus = useRef<OrderStatus | null>(null);
  const errors = useRef(0);
  const refreshing = useRef(false);
  const handle = useRef<{ close: () => void } | null>(null);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    errors.current = 0;

    const stop = () => {
      stopped.current = true;
      handle.current?.close();
      handle.current = null;
    };

    const open = () => {
      if (stopped.current) return;
      handle.current = openOrderStream(
        orderId,
        {
          onFrame: (f) => {
            // Advance an existing order; never materialise one. The stream sends the current
            // status on subscribe, so a frame routinely beats GET /orders/:id — and a
            // {status}-only object would render an order with no lines (spec §B1).
            qc.setQueryData<OrderDetail>(["order", orderId], (old) =>
              old ? { ...old, status: f.status } : old
            );
            if (f.status === "CANCELLED" && lastStatus.current)
              setFailedAt(lastStatus.current === "CONFIRMED" ? null : lastStatus.current);
            lastStatus.current = f.status;
            if (isTerminal(f.status)) {
              setPolling(false);
              stop();
            }
          },
          onError: () => {
            if (stopped.current || refreshing.current) return;
            errors.current += 1;
            if (errors.current === 1) {
              // Close BEFORE refreshing: EventSource reconnects on its own ~3s timer, and that
              // attempt would 401 again mid-refresh and spend a second rung (spec §B2).
              refreshing.current = true;
              handle.current?.close();
              handle.current = null;
              void refreshSession().finally(() => {
                refreshing.current = false;
                open();
              });
              return;
            }
            if (errors.current >= MAX_STREAM_ERRORS) {
              stop();
              setPolling(true);
            }
          },
        },
        create ? { create } : {}
      );
    };

    open();
    return stop;
  }, [orderId, qc, create]);

  return { polling, failedAt };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/web/src/hooks`
Expected: PASS, 7 tests.

- [ ] **Step 5: Gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm format:check
git add apps/web/src/hooks/useOrderStream.ts apps/web/src/hooks/__tests__/useOrderStream.test.tsx
git commit -m "feat(web): a fallback ladder that terminates"
```

---

### Task 6: The tracker, on the order page

**Files:**

- Create: `apps/web/src/components/OrderTracker.tsx`
- Modify: `apps/web/src/routes/Order.tsx`
- Modify: `apps/web/src/styles.css` (the pulse and its reduced-motion rule)
- Test: `apps/web/src/components/__tests__/OrderTracker.test.tsx`, extend `apps/web/src/routes/__tests__/Order.test.tsx`

**Interfaces:**

- Consumes: `stepsFor`, `Step`, `FailedAt` (Task 3); `useOrderStream`, `POLL_INTERVAL_MS` (Task 5).
- Produces: `<OrderTracker status={OrderStatus} failedAt={FailedAt} />`.

- [ ] **Step 1: Write the failing component test**

Create `apps/web/src/components/__tests__/OrderTracker.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import { OrderTracker } from "../OrderTracker";

it("marks the current step and announces it politely", () => {
  render(<OrderTracker status="AWAITING_PAYMENT" failedAt={null} />);
  const current = screen.getByRole("listitem", { current: "step" });
  expect(within(current).getByText("Payment")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(/payment/i);
});

it("labels every step in text, so colour is never the only channel", () => {
  render(<OrderTracker status="PENDING" failedAt={null} />);
  for (const label of ["Order placed", "Inventory reserved", "Payment", "Confirmed"])
    expect(screen.getByText(label)).toBeInTheDocument();
  // The state is readable without seeing the colour.
  expect(screen.getByText("Inventory reserved").closest("li")).toHaveTextContent(/in progress/i);
});

it("shows the compensation path when the failure was observed", () => {
  render(<OrderTracker status="CANCELLED" failedAt="AWAITING_PAYMENT" />);
  expect(screen.getByText("Payment").closest("li")).toHaveTextContent(/failed/i);
});

it("blames no step on a cold-loaded cancellation", () => {
  render(<OrderTracker status="CANCELLED" failedAt={null} />);
  expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(/cancelled/i);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/web/src/components/__tests__/OrderTracker.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tracker**

Create `apps/web/src/components/OrderTracker.tsx`:

```tsx
import type { OrderStatus } from "@ecom/contracts";
import { stepsFor, type FailedAt, type Step } from "../order/saga-steps";

// Colour encodes saga state per the design language — so every step ALSO carries a glyph and a
// text state, and the pipeline stays readable in greyscale and to a screen reader.
const GLYPH: Record<Step["state"], string> = {
  done: "✓",
  active: "●",
  failed: "✕",
  pending: "○",
};
const STATE_TEXT: Record<Step["state"], string> = {
  done: "done",
  active: "in progress",
  failed: "failed",
  pending: "waiting",
};
const TONE: Record<Step["state"], string> = {
  done: "text-[color:var(--color-ok)]",
  active: "text-[color:var(--color-pending)]",
  failed: "text-[color:var(--color-danger)]",
  pending: "text-[color:var(--color-muted)]",
};

function announce(status: OrderStatus, steps: Step[]): string {
  if (status === "CONFIRMED") return "Order confirmed";
  if (status === "CANCELLED") {
    const failed = steps.find((s) => s.state === "failed");
    return failed ? `Order cancelled — ${failed.label} failed` : "Order cancelled";
  }
  const active = steps.find((s) => s.state === "active");
  return active ? `${active.label} in progress` : "Order placed";
}

export function OrderTracker({
  status,
  failedAt,
}: {
  status: OrderStatus;
  failedAt: FailedAt;
}) {
  const steps = stepsFor(status, failedAt);
  return (
    <div>
      <ol className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-6">
        {steps.map((s) => (
          <li
            key={s.key}
            aria-current={s.state === "active" ? "step" : undefined}
            className="flex items-center gap-2 sm:flex-1"
          >
            <span aria-hidden="true" className={`${TONE[s.state]} ${s.state === "active" ? "tracker-pulse" : ""}`}>
              {GLYPH[s.state]}
            </span>
            <span className="datum text-sm">{s.label}</span>
            <span className="sr-only">{STATE_TEXT[s.state]}</span>
          </li>
        ))}
      </ol>
      {/* Polite, not assertive: the saga can produce three transitions in a few seconds, and
          none of them is an interruption. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announce(status, steps)}
      </p>
    </div>
  );
}
```

If `--color-ok`, `--color-pending`, `--color-danger` are not already declared in the `@theme static` block of `apps/web/src/styles.css`, add them there — **`@theme` is tree-shaken and arbitrary values do not count as references**, which is 8a's trap.

- [ ] **Step 4: Add the pulse and its reduced-motion rule**

In `apps/web/src/styles.css`:

```css
@keyframes tracker-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

.tracker-pulse {
  animation: tracker-pulse 1.4s ease-in-out infinite;
}

/* Removed, not substituted: no slower pulse, no cross-fade. The step still reads as active
   through aria-current, its glyph and its colour. */
@media (prefers-reduced-motion: reduce) {
  .tracker-pulse {
    animation: none;
  }
}
```

- [ ] **Step 5: Run the component test**

Run: `pnpm vitest run apps/web/src/components/__tests__/OrderTracker.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 6: Wire it into the order page**

In `apps/web/src/routes/Order.tsx`: call the hook, feed the query, render the tracker.

```tsx
const { polling, failedAt } = useOrderStream(id);
const order = useQuery({
  queryKey: ["order", id],
  queryFn: () => getOrder(id),
  refetchInterval: polling ? POLL_INTERVAL_MS : false,
});
```

Replace the `<h1>Order placed</h1>` heading with `<h1>Order</h1>` (it is reached from history too — spec §H), keep the `<Badge>`, and render `<OrderTracker status={order.data.status} failedAt={failedAt} />` directly beneath the heading row. Stop polling automatically: the hook clears `polling` on a terminal frame, and a terminal status also ends the stream, so add

```tsx
refetchInterval: polling && !isTerminalStatus(order.data?.status) ? POLL_INTERVAL_MS : false,
```

with a local `const isTerminalStatus = (s?: OrderStatus) => s === "CONFIRMED" || s === "CANCELLED";` — the fallback transport must stop on its own, because in polling mode no frame will ever arrive to stop it.

- [ ] **Step 7: Extend the route test**

Append to `apps/web/src/routes/__tests__/Order.test.tsx`:

```tsx
it("renders the pipeline for the order's status", async () => {
  vi.spyOn(ordersApi, "getOrder").mockResolvedValue(detail({ status: "AWAITING_PAYMENT" }));
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([]);
  renderAt("o1");
  expect(await screen.findByText("Inventory reserved")).toBeInTheDocument();
  expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent("Payment");
});
```

The route now calls `useOrderStream`, which constructs a real `EventSource` by default — undefined in jsdom. Pass a no-op factory through the hook's default only in the test by stubbing the module:

```tsx
vi.mock("../../hooks/useOrderStream", () => ({
  useOrderStream: () => ({ polling: false, failedAt: null }),
  POLL_INTERVAL_MS: 3000,
}));
```

- [ ] **Step 8: Run the route suite**

Run: `pnpm vitest run apps/web/src/routes/__tests__/Order.test.tsx`
Expected: PASS, existing tests plus the new one.

- [ ] **Step 9: Gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm format:check
git add apps/web/src/components/OrderTracker.tsx apps/web/src/components/__tests__/OrderTracker.test.tsx apps/web/src/routes/Order.tsx apps/web/src/routes/__tests__/Order.test.tsx apps/web/src/styles.css
git commit -m "feat(web): the order pipeline, live"
```

---

### Task 7: Order history

**Files:**

- Create: `apps/web/src/routes/Orders.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/components/Layout.tsx`
- Test: `apps/web/src/routes/__tests__/Orders.test.tsx`

**Interfaces:**

- Consumes: `listOrders` (Task 2), `OrderSummary` (Task 1).
- Produces: the `/orders` route.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/routes/__tests__/Orders.test.tsx`:

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { makeQueryClient } from "../../api/queryClient";
import { NetworkError } from "../../api/errors";
import * as ordersApi from "../../api/orders";
import { Orders } from "../Orders";

function renderList() {
  const router = createMemoryRouter(
    [
      { path: "/orders", element: <Orders /> },
      { path: "/orders/:id", element: <div>detail</div> },
    ],
    { initialEntries: ["/orders"] }
  );
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
afterEach(() => vi.restoreAllMocks());

it("lists the caller's orders with their status and total", async () => {
  vi.spyOn(ordersApi, "listOrders").mockResolvedValue([
    {
      id: "o2",
      status: "CONFIRMED",
      totalPrice: 2500,
      itemCount: 2,
      createdAt: "2026-08-04T10:00:00.000Z",
    },
  ]);
  renderList();
  expect(await screen.findByText("o2")).toBeInTheDocument();
  expect(screen.getByText("CONFIRMED")).toBeInTheDocument();
  expect(screen.getByText("$25.00")).toBeInTheDocument();
  expect(screen.getByText(/2 items/)).toBeInTheDocument();
});

it("shows an empty state rather than a blank page", async () => {
  vi.spyOn(ordersApi, "listOrders").mockResolvedValue([]);
  renderList();
  expect(await screen.findByText(/no orders yet/i)).toBeInTheDocument();
});

it("shows an error state when the gateway cannot be reached", async () => {
  vi.spyOn(ordersApi, "listOrders").mockRejectedValue(new NetworkError(new Error("down")));
  renderList();
  expect(await screen.findByText(/could not be reached/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/web/src/routes/__tests__/Orders.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the page**

Create `apps/web/src/routes/Orders.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { listOrders } from "../api/orders";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { Price } from "../components/Price";
import { Skeleton } from "../components/Skeleton";

export function Orders() {
  const orders = useQuery({ queryKey: ["orders"], queryFn: listOrders });

  if (orders.isPending) return <Skeleton />;
  if (orders.error) return <ErrorState error={orders.error} />;
  if (orders.data.length === 0)
    return <EmptyState>No orders yet — placing one starts the pipeline.</EmptyState>;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl">Your orders</h1>
      <ul className="flex flex-col">
        {orders.data.map((o) => (
          <li key={o.id} className="border-b border-[color:var(--color-line)] py-3">
            <Link to={`/orders/${o.id}`} className="flex items-center justify-between gap-4">
              <span className="datum text-sm">{o.id}</span>
              <span className="datum text-xs text-[color:var(--color-muted)]">
                {o.itemCount} items
              </span>
              <Badge>{o.status}</Badge>
              <Price minorUnits={o.totalPrice} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

Match `EmptyState`/`ErrorState`'s real prop signatures — read those two components before writing this.

- [ ] **Step 4: Register the route and the nav link**

In `apps/web/src/App.tsx`, beside the existing `/orders/:id` entry — **`/orders` must be listed before `/orders/:id`** is not required by React Router 8 (exact paths win), but keep them adjacent for readability:

```tsx
{
  path: "/orders",
  element: (
    <RequireAuth>
      <Orders />
    </RequireAuth>
  ),
},
```

In `apps/web/src/components/Layout.tsx`, inside the `<nav>` and only when the session is authenticated, add `<Link to="/orders" className="datum text-sm">Orders</Link>` next to the cart link.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run apps/web/src/routes`
Expected: PASS, including the untouched suites.

- [ ] **Step 6: Gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm format:check
git add apps/web/src/routes/Orders.tsx apps/web/src/routes/__tests__/Orders.test.tsx apps/web/src/App.tsx apps/web/src/components/Layout.tsx
git commit -m "feat(web): order history"
```

---

### Task 8: The accessibility sweep

**Files:**

- Modify: `apps/web/src/components/Layout.tsx`, `apps/web/src/styles.css`
- Modify: `apps/web/src/routes/Login.tsx`, `Register.tsx`, `Cart.tsx` as the audit requires
- Test: `apps/web/src/components/__tests__/Layout.test.tsx` (create)

**Scope is closed** (spec §C): skip link, heading order, visible focus, labelled inputs. Anything else found is a note for the merge record, not a change.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/__tests__/Layout.test.tsx`:

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { makeQueryClient } from "../../api/queryClient";
import * as sessionApi from "../../api/session";
import { Layout } from "../Layout";

function renderLayout() {
  const router = createMemoryRouter([{ element: <Layout />, children: [{ index: true, element: <h1>Home</h1> }] }], {
    initialEntries: ["/"],
  });
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
afterEach(() => vi.restoreAllMocks());

it("offers a skip link that targets the main region", async () => {
  vi.spyOn(sessionApi, "probeSession").mockResolvedValue({ authenticated: false, cart: null });
  renderLayout();
  const skip = screen.getByRole("link", { name: /skip to content/i });
  expect(skip).toHaveAttribute("href", "#main");
  expect(screen.getByRole("main")).toHaveAttribute("id", "main");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/web/src/components/__tests__/Layout.test.tsx`
Expected: FAIL — no skip link.

- [ ] **Step 3: Add the skip link and the main landmark**

In `apps/web/src/components/Layout.tsx`, as the first child of the wrapper:

```tsx
<a
  href="#main"
  className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-[color:var(--color-surface)] focus:px-3 focus:py-2"
>
  Skip to content
</a>
```

and give the element wrapping `<Outlet />` `id="main"` plus `role`-implying `<main>`.

- [ ] **Step 4: Audit the three forms**

Run the app (`pnpm --filter @ecom/web dev`) and check with the keyboard alone: every input in Login, Register and Cart reachable and announced by a `<label htmlFor>` (not a placeholder), a visible focus ring on every interactive element, and one `<h1>` per route with no skipped levels. Fix what fails; change nothing that passes.

- [ ] **Step 5: Run the whole web suite**

Run: `pnpm vitest run apps/web`
Expected: PASS.

- [ ] **Step 6: Gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm format:check
git add apps/web/src/components/Layout.tsx apps/web/src/components/__tests__/Layout.test.tsx apps/web/src/styles.css apps/web/src/routes
git commit -m "feat(web): skip link, labelled inputs, visible focus"
```

---

### Task 9: Playwright, locally

**Files:**

- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/checkout.spec.ts`, `apps/web/e2e/compensation.spec.ts`, `apps/web/e2e/session-expiry.spec.ts`, `apps/web/e2e/fixtures.ts`
- Modify: `apps/web/package.json` (devDependency + `e2e` script), `docs/infra.md` (how to run)

**Preconditions:** a full stack is up (`docker compose up -d`), migrations applied, and an admin credential available for `POST /products`. The suite is **not** wired into CI (spec §F4).

- [ ] **Step 1: Install and configure**

```bash
pnpm --filter @ecom/web add -D @playwright/test
pnpm --filter @ecom/web exec playwright install chromium
```

Create `apps/web/playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

// Local only. CI's quality job has no compose stack, and standing eight services plus two
// brokers up to run three browser walks is its own slice (spec §F4).
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: { baseURL: process.env.WEB_URL ?? "http://localhost:5173", trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
```

Add to `apps/web/package.json` scripts: `"e2e": "playwright test"`.

- [ ] **Step 2: Write the fixture that can force a decline**

Create `apps/web/e2e/fixtures.ts`:

```ts
import { request as pwRequest } from "@playwright/test";

const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:8000";

// Payment declines when the total's minor units satisfy % 100 === 1
// (services/payment/src/charge.ts:8). The storefront cannot choose an amount — the total comes
// from catalog prices through Order's read model — so a decline walk has to create a product
// priced to land there. 99 is deliberately avoided: that is the async webhook path, which
// parks in PROCESSING and never settles on its own.
export const DECLINING_PRICE = 1301;
export const SETTLING_PRICE = 1300;

export async function createProduct(price: number, tag: string): Promise<string> {
  const ctx = await pwRequest.newContext({ baseURL: GATEWAY });
  const login = await ctx.post("/auth/login", {
    data: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },
  });
  if (!login.ok()) throw new Error(`admin login failed: ${login.status()}`);
  const res = await ctx.post("/products", {
    data: {
      type: "ELECTRONICS",
      name: `${tag}-${Date.now()}`,
      price,
      attributes: { manufacturer: "e2e", model: tag },
    },
  });
  if (!res.ok()) throw new Error(`product create failed: ${res.status()}`);
  const body = await res.json();
  await ctx.dispose();
  return body.id;
}
```

Read `services/catalog`'s create route and its per-type attribute schema before finalising the payload — the shape must match what catalog actually validates. Stock must also exist in Inventory for the product, or the saga cancels at the reservation leg; seed it the way `infra/scripts/drive-checkouts.ts` expects.

- [ ] **Step 3: Write the three walks**

`apps/web/e2e/checkout.spec.ts` — register or sign in, add the `SETTLING_PRICE` product, check out, and assert the tracker reaches `CONFIRMED` **without a reload**:

```ts
import { test, expect } from "@playwright/test";
import { createProduct, SETTLING_PRICE } from "./fixtures";

test("browse → cart → checkout → the pipeline confirms live", async ({ page }) => {
  const productId = await createProduct(SETTLING_PRICE, "e2e-settle");
  await page.goto(`/products/${productId}`);
  await page.getByRole("button", { name: /add to cart/i }).click();
  await page.getByRole("textbox", { name: /email/i }).fill(process.env.E2E_EMAIL!);
  await page.getByRole("textbox", { name: /password/i }).fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.getByRole("link", { name: /cart/i }).click();
  await page.getByRole("button", { name: /place order/i }).click();
  await expect(page.getByRole("listitem", { current: "step" })).toContainText(/inventory|payment/i);
  // No reload anywhere in this assertion: reaching CONFIRMED proves the stream, not the query.
  await expect(page.getByText("CONFIRMED")).toBeVisible({ timeout: 30_000 });
});
```

`apps/web/e2e/compensation.spec.ts` — identical up to checkout, using `DECLINING_PRICE`, then assert the failed step and `CANCELLED`.

`apps/web/e2e/session-expiry.spec.ts` — place an order, clear the access-token cookie mid-saga (`page.context().clearCookies({ name: … })` for the access cookie only, leaving the refresh cookie), and assert the tracker still reaches its terminal state — this is what exercises the ladder's refresh rung (8b's deferred walk).

- [ ] **Step 4: Run them**

```bash
docker compose up -d
pnpm --filter @ecom/web dev &   # or point WEB_URL at the nginx build from Task 10
pnpm --filter @ecom/web e2e
```

Expected: 3 passed. A failure here is a real finding — record it, do not weaken the assertion.

- [ ] **Step 5: Document and commit**

Add a short "Storefront e2e" section to `docs/infra.md`: prerequisites, the env vars the fixtures read, and the two commands. Then:

```bash
pnpm typecheck && pnpm lint && pnpm format:check
git add apps/web/playwright.config.ts apps/web/e2e apps/web/package.json pnpm-lock.yaml docs/infra.md
git commit -m "test(web): three local walks, including the compensation path"
```

---

### Task 10: Packaging

**Files:**

- Create: `apps/web/Dockerfile`, `apps/web/nginx.conf`
- Modify: `docker-compose.prod.example.yml`

- [ ] **Step 1: Write the nginx config**

Create `apps/web/nginx.conf`:

```nginx
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;

  # A deep link (/orders/abc) is a client route, not a file.
  location / {
    try_files $uri /index.html;
  }

  location /api/ {
    proxy_pass http://gateway:8000/;
    proxy_http_version 1.1;
    # LOAD-BEARING: with buffering on, nginx accumulates the SSE stream and the tracker sits
    # motionless while the backend works perfectly — a backend success that reads as a
    # frontend bug.
    proxy_buffering off;
    proxy_cache off;
    # Must outlive an idle stream between the service's 15s heartbeats.
    proxy_read_timeout 1h;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

- [ ] **Step 2: Write the Dockerfile**

Create `apps/web/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
# Unlike the services (which run TypeScript through tsx and have NO build step), the app is a
# real Vite build: the browser gets static assets, not source.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ecom/web build

FROM nginx:alpine AS runtime
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

- [ ] **Step 3: Add the service to the prod overlay**

In `docker-compose.prod.example.yml` (an overlay — a service defined only here is still created):

```yaml
  # The storefront. Published because it is the human entry point; the gateway keeps its own
  # published port because the payment provider's webhook is an inbound call that does not
  # pass through nginx.
  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
    depends_on: [gateway]
    ports: ["8080:80"]
    restart: unless-stopped
```

- [ ] **Step 4: Verify by running it**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.example.yml up -d --build web
```

Then, in a browser at `http://localhost:8080`: hard-refresh a deep link (`/orders/<id>`) and confirm the app renders rather than a 404; place an order and confirm the tracker **advances without a reload through nginx**. The second check is the one that catches a buffering regression, and no test can substitute for it.

- [ ] **Step 5: Commit**

```bash
pnpm format:check
git add apps/web/Dockerfile apps/web/nginx.conf docker-compose.prod.example.yml
git commit -m "feat(web): packaged behind nginx, with the stream unbuffered"
```

---

### Task 11: Carried debt

**Files:**

- Modify: `packages/contracts/src/http/order.ts`, `apps/web/src/api/cart.ts`, `services/order/src/metrics.ts`
- Test: extend `apps/web/src/api/__tests__/cart.test.ts`, `apps/web/src/routes/__tests__/Cart.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/api/__tests__/cart.test.ts`, add a case proving an unknown field is now rejected:

```ts
it("rejects a cart response carrying an unknown field", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ userId: "u1", items: [], surprise: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  await expect(getCart()).rejects.toThrow(/did not match its contract/);
});
```

In `apps/web/src/routes/__tests__/Cart.test.tsx`, add the two missing cases from 8b: setting a quantity to zero removes the line, and a multi-line cart's estimate is the sum of its lines.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run apps/web/src/api/__tests__/cart.test.ts apps/web/src/routes/__tests__/Cart.test.tsx`
Expected: the strictness case FAILS (extra keys are currently stripped silently).

- [ ] **Step 3: Tighten the contract**

In `packages/contracts/src/http/order.ts`, make `CartItemSchema` and `CartSchema` strict:

```ts
export const CartItemSchema = z.object({ … }).strict();
export const CartSchema = z.object({ … }).strict();
```

This is two-sided: Order asserts its own cart responses against these schemas
(`services/order/src/__tests__/cart-order-contract.int.test.ts`), so an additive server field now
fails a backend test beside the change that caused it. Nothing sends extras today, so the change
is inert on landing and load-bearing afterwards.

- [ ] **Step 4: Fix the stale comment**

In `apps/web/src/api/cart.ts`, the comment claiming a 200 for `POST /cart/items` becomes 201 — the route answers 201 (`services/order/src/app.ts:48`).

- [ ] **Step 5: Widen the saga histogram**

In `services/order/src/metrics.ts`, add boundaries near 1.5 and 2 seconds to `SAGA_BUCKETS`. 7d reproduced by hand that the 1 → 2.5 gap overestimates saga p99 in that range; the `<5s` SLO is unaffected either way.

- [ ] **Step 6: Run the affected suites**

Run: `pnpm vitest run apps/web packages services/order/src/__tests__/cart-order-contract.int.test.ts services/order/src/__tests__/saga-metrics.unit.test.ts`
Expected: PASS.

- [ ] **Step 7: Gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm format:check
git add packages/contracts/src/http/order.ts apps/web/src/api/cart.ts apps/web/src/api/__tests__/cart.test.ts apps/web/src/routes/__tests__/Cart.test.tsx services/order/src/metrics.ts
git commit -m "fix: close the minors 8b and 7d left behind"
```

---

## Acceptance (run before requesting the whole-branch review)

- [ ] `pnpm typecheck && pnpm lint && pnpm format:check && pnpm -r build` all clean.
- [ ] `pnpm vitest run` — whole workspace green.
- [ ] Compose stack up; place an order in a browser and watch the tracker advance **with no reload**.
- [ ] Force a decline (a product priced `…01`) and see the failed step and `CANCELLED`.
- [ ] Break the stream mid-saga (stop `order`, or block SSE in devtools) and confirm the page lands on polling and still reaches its terminal state.
- [ ] `/orders` lists your orders and nobody else's.
- [ ] Keyboard-only walk of the tracker and the forms; then re-check with `prefers-reduced-motion: reduce` forced in devtools.
- [ ] `docker compose -f docker-compose.yml -f docker-compose.prod.example.yml up -d --build web`, then a live tracker at `http://localhost:8080`.
- [ ] Write `.scratch/phase-8c/impl-notes.html` as deviations occur — do not reconstruct it at the end.
