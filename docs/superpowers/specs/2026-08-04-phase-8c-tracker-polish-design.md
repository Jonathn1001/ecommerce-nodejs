# Phase 8c · Order-pipeline tracker + polish — Design (child spec)

Parent: `2026-07-18-microservices-streaming-rebuild-design.md` §Phase 8
Roadmap: `2026-07-23-phases-3-8-roadmap.md` §Phase 8, slice 8c
Siblings: `2026-07-30-phase-8a-storefront-foundation-design.md`, `2026-08-03-phase-8b-auth-cart-checkout-design.md`

## Purpose

8b left a storefront that can transact but cannot show what happens next: the order page renders
a status that only a manual reload changes. 8c makes the saga visible. The order-pipeline
tracker is the phase's signature element — the one screen where a choreographed distributed
transaction stops being an architecture diagram and becomes something a user watches resolve.

This is also the last slice of the 3–8 roadmap. Everything it leaves behind is unscheduled
backlog, not a planned successor, so the deferral bar here is higher than in earlier slices.

## Scope

**In:** the live tracker on `/orders/:id` (SSE with a terminating fallback ladder to polling);
order history at `/orders`, backed by a new `GET /orders` on the Order service; an accessibility
sweep including `prefers-reduced-motion`; a local Playwright e2e suite; `apps/web/Dockerfile`
plus nginx and a prod-compose entry; and four pieces of carried debt (§H).

**Out:** guest carts, addresses and shipping, cancelling or refunding from the UI, an admin or
ops surface, a Playwright lane in CI (§F4), and cursor pagination on order history (§D2).

## Preconditions

Verified against the tree at `936842b` (8b merged) before this spec was written:

| Fact | Where |
|---|---|
| `GET /orders/:id/stream` exists: `event: status`, `data {orderId,status}`, `:keepalive` every 15s, closes on terminal | `services/order/src/app.ts:214` |
| The stream 404s a non-owner **before** any SSE header is written | `services/order/src/app.ts:224` |
| The stream answers 503 when the registry is absent, 400 without `x-user-id` | `services/order/src/app.ts:216` |
| The gateway proxies the stream authenticated and **exempt from breaker + timeout** | `services/gateway/src/app.ts:210`, `proxy.ts:27` |
| Order has **no list endpoint** — only `POST /orders`, `GET /orders/:id`, `GET /orders/:id/stream` | `services/order/src/app.ts` |
| `OrderStatusSchema` is exactly `PENDING \| AWAITING_PAYMENT \| CONFIRMED \| CANCELLED` | `packages/contracts/src/http/order.ts:28` |
| `PENDING`+reserved → `AWAITING_PAYMENT`; `PENDING`+reservation-failed → `CANCELLED`; `AWAITING_PAYMENT`+payment-failed → `CANCELLED` — the whole basis of §A1 | `services/order/src/transition.ts:14` |
| `request()` owns the single-flight refresh and one retry; `HttpError` carries a status and nothing else | `apps/web/src/api/request.ts`, `errors.ts` |
| The browser calls same-origin `/api/*`; Vite strips the prefix in dev | `apps/web/vite.config.ts` |
| jsdom provides **no** `EventSource` | `apps/web/vitest.config.ts` (environment: jsdom) |

## A. Four statuses, four steps

### A1. The tracker derives its steps client-side

The umbrella prototype draws the pipeline as `PENDING → InventoryReserved → PaymentSucceeded →
CONFIRMED`, but the stream carries an `Order.status`, and "inventory reserved" is not one. It
does not need to be: **an order cannot reach `AWAITING_PAYMENT` unless the reservation
succeeded** — the transition is written by the reserve-leg consumer, and a failed reservation
cancels instead. `AWAITING_PAYMENT` is therefore *evidence* of a reserved inventory and an
in-flight charge, and the four steps are recoverable from the four statuses without touching a
service.

| Status | Placed | Inventory reserved | Payment | Confirmed |
|---|---|---|---|---|
| `PENDING` | done | active | pending | pending |
| `AWAITING_PAYMENT` | done | done | active | pending |
| `CONFIRMED` | done | done | done | done |
| `CANCELLED` | done | *see below* | failed | — |

`CANCELLED` is the compensation path and is the one row that cannot be read off the status
alone: an order cancelled by a reservation failure never reserved anything, while one cancelled
by a declined payment reserved and then released. The status does not say which. **The tracker
marks a specific step failed only when it observed the transition live** — the step that was
active when the terminal frame arrived is the one that failed. On a cold load of an
already-cancelled order it names **no** step: the pipeline renders as ended and the card says
the order was cancelled. Guessing "payment" there would be a false statement to the user for
every reservation-failed order, and "we do not know" is a thing this UI is allowed to say.

The alternative, emitting saga sub-events so the client is told rather than inferring, means a
new column, a migration, and a new frame DTO. Rejected: it inflates the last slice of the
roadmap to make an inference that is already sound for three of four rows.

### A2. The mapping lives in one pure module

`apps/web/src/order/saga-steps.ts` exports `stepsFor(status, activeAtTerminal?)` returning a
list of `{key, label, state}` with `state: "done" | "active" | "failed" | "pending"`. No React,
no EventSource, no fetch. Every claim in §A1's table is one row of one unit test, and the
component that renders it never learns what `AWAITING_PAYMENT` implies.

## B. Liveness

### B1. The stream writes into the query cache, and the page reads only the cache

`useOrderStream(id)` opens the EventSource and, for each frame, does

```ts
queryClient.setQueryData(["order", id], (old) => old && { ...old, status: frame.status });
```

The route continues to render from `useQuery(["order", id])`. One source of truth, so a page
that remounts or a badge rendered elsewhere cannot disagree with the tracker, and the polling
fallback (§B2) needs no separate data path — it is a flag on the same query.

**The `old &&` guard is load-bearing.** The stream sends the current status immediately on
subscribe, so a frame routinely arrives before `GET /orders/:id` resolves. Without the guard,
`setQueryData` would materialise `{status}` with no `items` and no `totalPrice`, and the route —
which trusts a resolved query — would render an order with no lines. This is the same class of
bug as 8b's "fabricated `$0.00`", and it is the reason the stream is not allowed to *create*
cache entries, only to advance one.

### B2. The fallback ladder terminates

`EventSource` reconnects on its own, forever, and exposes no status code — a 401 from an expired
access token, a 404 on someone else's order, and a dropped Wi-Fi connection are the same
`onerror` event. The ladder therefore counts errors rather than interpreting them:

1. **First `onerror`** — **close the stream**, `await refreshSession()` (the existing
   single-flight helper), then open a *fresh* EventSource. An access token expiring mid-saga is
   the expected cause and the only one the client can fix. Closing first is not optional:
   EventSource reconnects on its own timer (~3s — the service sends no `retry:` field), so
   leaving it open means the reconnect fires *before* the refresh resolves, 401s again, and
   spends a rung on a problem that was already being fixed. Errors arriving while a refresh is
   in flight do not increment the counter.
2. **Third `onerror`** — `es.close()`, switch the query to `refetchInterval: POLL_INTERVAL_MS`
   (3000).
3. **Terminal status** (`CONFIRMED` or `CANCELLED`), from either transport — close the stream,
   clear the interval, stop. A settled order never polls.
4. **Unmount** — close both.

**Never both transports at once.** Running SSE and polling together would keep the page correct
while the stream is completely broken, which is precisely the failure this phase exists to make
visible.

The ladder must terminate for a second reason: a stream for an order the caller does not own
404s before any SSE header, so an infinite reconnect would retry a permanent failure forever and
show nothing. Falling to polling makes `GET /orders/:id` answer 404 and hands the user 8b's
existing "Order not found" view.

`POLL_INTERVAL_MS = 3000` is chosen against the `saga_duration p(99)<5000` threshold
(`k6/checkout.js:21`): fast enough that a fallback user sees the pipeline move, slow enough that
a settled-but-open page is not a load source. It is a named constant in one module, never a
literal at a call site.

### B3. The frame is a NAMED event, and `EventSource` is injected

The service writes `event: status\ndata: {...}` (`services/order/src/app.ts:241`). `EventSource`
delivers a **named** event only to `addEventListener("status", …)` — `onmessage` fires for
unnamed frames and would therefore **never fire at all** here. The client listens by name, and
so does the test fake.

This is the single most dangerous detail in the slice: a fake that dispatches through
`onmessage` makes every ladder test in §F1 pass against a page that receives nothing, which is
7c's "six tests that pass against a broken implementation" reproduced exactly. The plan's exit
criterion for the stream module is that removing the `addEventListener("status")` wiring makes a
test fail.

`apps/web/src/api/stream.ts` exports `openOrderStream(id, handlers, { create })` where `create`
defaults to `(url) => new EventSource(url)`. Tests pass a fake that records `close()` calls and
dispatches named `status` events plus `error` on demand. The seam is required, not stylistic:
`EventSource` is `undefined` in the test environment — jsdom does not implement it and Node
22.21 has no global either.

The URL is `/api/orders/:id/stream`, same-origin, so the session cookie rides automatically;
`EventSource` cannot set headers, which is why the gateway authenticates the stream from the
cookie and not from a bearer token (already true since 6b).

## C. Rendering

`OrderTracker` takes a status and renders steps. It is presentational, has no hooks beyond
layout, and is the only place the design language's colour rules apply.

**Colour is never the only channel.** The design language reserves amber/green/red to encode
saga state, so each step carries an icon and a text label as well; a red step reads as failed in
greyscale and to a screen reader.

The tracker is an ordered list. The active step carries `aria-current="step"`, and a visually
hidden `aria-live="polite"` region announces transitions ("Payment confirmed"). Polite, not
assertive: a status change is not an interruption, and the saga can produce three in a few
seconds.

Under `prefers-reduced-motion: reduce` the active step's pulse is **removed, not substituted** —
no cross-fade, no slower pulse. The step still reads as active through `aria-current`, its icon,
and its colour.

The sweep beyond the tracker: a skip link in `Layout`, heading order checked per route, visible
focus rings, and a label on every input in Login, Register and Cart. Bounded and named here so
it does not become an open-ended redesign.

## D. Order history

### D1. `GET /orders` is a new endpoint, and the gateway needs no change

The Order service gains a list scoped by `x-user-id`, ordered `createdAt desc`, capped at 50
rows, returning a summary per order: `{id, status, totalPrice, createdAt, itemCount}`. Ownership
stays where every other order route keeps it — in the service, not the gateway.

The gateway's `RULES` table is an allowlist of *permissions*, not of routes: anything absent
needs authentication only. `GET /orders` is absent, and `app.use("/orders", authRequired, authz,
guard("order", …))` already proxies it. **No gateway file changes**, and that is a claim the
plan should verify by test rather than by reading.

`OrderSummarySchema` is a new contract; `itemCount` is served from a Prisma `_count`, so a
history row can say "3 items" without shipping every line.

### D2. The cap is a decision, not an omission

50 rows, no cursor, no page control. A learning storefront has no user with 51 orders, and a
half-built pagination is worse than a documented ceiling. The response is a plain array; if the
ceiling ever matters, adding a cursor is a widening change, not a breaking one.

### D3. `/orders` the page and `/api/orders` the API cannot collide

8a's `/api/*` decision is what makes this safe: the proxy owns one prefix and the router owns
the origin root, so a hard refresh on `/orders` serves the app. This is the exact bug 8a hit
with `/products` and the reason the prefix exists.

## E. Error handling

### E1. `HttpError` learns to carry a body

`request()` reads the error body when the response declares JSON, and attaches it as
`HttpError.body`. That closes 8b's §D1 drift: Order deliberately puts `productId` in its 422
body, but `HttpError(status)` discarded it, so checkout's recovery said "one of these products"
instead of naming it. With the body available, `describeCheckoutFailure` joins the id against
the cached catalogue and names the product.

Parsing is best-effort and must never throw: a non-JSON or truncated error body leaves
`body: undefined` and the generic message, exactly as today. The status remains the field
everything branches on.

### E2. The failure taxonomy is unchanged

`NetworkError`, `HttpError`, `SchemaMismatchError`, `UnauthenticatedError` keep their meanings.
A stream failure is not added to the taxonomy — the ladder resolves it into either a working
transport or an ordinary query error, so nothing above `useOrderStream` learns that SSE exists.

## F. Testing

### F1. Unit

- `stepsFor` — one case per row of §A1's table, plus the cold-load `CANCELLED` fallback.
- Frame delivery: a fake dispatching a **named** `status` event reaches the handler, and the
  test fails if the listener is registered as `onmessage`.
- The ladder, against the fake EventSource: rung 1 closes the stream, waits for the refresh, and
  opens a new one; errors during an in-flight refresh do not count; exactly one
  `refreshSession()` across a burst of errors; polling starts on the third error and not before;
  a terminal frame stops everything; unmount closes the stream; polling never runs while the
  stream is open.
- `setQueryData` guard: a frame arriving before the GET resolves leaves the cache untouched.

### F2. Component

Tracker at each status, the compensation branch, and the reduced-motion variant; history list,
empty and error states.

### F3. Backend integration

`GET /orders` returns only the caller's orders, newest first, capped at 50, with `itemCount`
matching the lines. Runs against live Postgres like 8b's order contract test, and tags and
deletes its own rows per the 7d convention.

### F4. Playwright, local only

`pnpm --filter @ecom/web e2e` against a running compose stack. The slice adds
`@playwright/test`, a `playwright.config.ts` under `apps/web`, the `e2e` script, and a
documented `pnpm exec playwright install chromium` step — named here so the plan does not invent
them. One browser (chromium) only.

Three walks:

1. browse → add to cart → login → checkout → the tracker reaches `CONFIRMED` live;
2. the compensation path, forced with the declining magic amount — `charge()` returns `FAILED`
   when minor-units `% 100 == 1` (`services/payment/src/charge.ts:8`) → the tracker shows the
   failed step and `CANCELLED`;
3. a session expiring mid-order — 8b's deferred mid-session-expiry walk, which is what proves
   the ladder's refresh rung.

**Walk 2 needs a fixture the storefront cannot produce by clicking.** The total comes from
catalog prices through Order's read model, so the suite must create its own product priced to
land on `…01` at quantity 1 (e.g. 1301 minor units) via `POST /products` as an admin, and add
exactly that one line. There is no catalog seed script to lean on — the only seed in the repo is
`services/identity/prisma/seed.ts`, and `infra/scripts/drive-checkouts.ts:8` requires a
`PRODUCT_ID` handed to it. The fixture tags and removes its own product, per 7d's rule that a
test cleans the dev database it dirtied. Avoid `% 100 == 99`: that is the async-webhook path,
which parks in `PROCESSING` and never settles on its own.

CI stays out. The `quality` job auto-globs `services/*` and has no compose stack; standing up
eight services, Kafka, RabbitMQ and Postgres to run three browser walks is its own slice, and
attempting it inside the last storefront slice would spend most of the slice debugging a runner.
Stated here so the absence is a decision on the record, not a gap.

## G. Packaging

`apps/web/Dockerfile` is multi-stage: a Node stage runs `pnpm --filter @ecom/web build` (the app
needs a real Vite build, unlike the services, which run TypeScript through tsx), and the output
is copied into `nginx:alpine`.

nginx does two things. `try_files $uri /index.html` so a deep link survives a refresh, and

```
location /api/ {
  proxy_pass http://gateway:8000/;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_read_timeout 1h;
}
```

**`proxy_buffering off` is the load-bearing line.** With buffering on, nginx accumulates the
stream and the tracker sits motionless while the backend works perfectly — a failure that looks
like a frontend bug and is not. `proxy_read_timeout` must outlive an idle stream between
heartbeats; the service sends `:keepalive` every 15s, so anything over a minute would do and an
hour removes the question.

The `web` service is added to `docker-compose.prod.example.yml` only. Dev keeps the Vite dev
server — HMR is the reason it exists, and containerising dev trades it for nothing. The overlay
may introduce a service the base file does not define, so no change to
`docker-compose.example.yml` is needed. The gateway keeps its published port: the payment
provider's webhook is an inbound call that does not pass through nginx.

## H. Carried debt closed here

| Item | Origin |
|---|---|
| `HttpError` carries a parsed body; 422 names the product | 8b §D1 drift (§E1) |
| Cart contract schemas become strict; `cart.ts` comment says 201, not 200 | 8b deferred minors |
| `Order.tsx` stops being headed "Order placed" — it is also reached from history | this slice's own §D |
| `SAGA_BUCKETS` gains boundaries near 1.5s and 2s in `services/order/src/metrics.ts` | 7d lesson: the 1→2.5 gap overestimates saga p99 in that range |
| Cart tests for decrement-to-zero and a multi-line estimate | 8b deferred minors |

The `SAGA_BUCKETS` change is backend and unrelated to the storefront; it is here because this
slice already opens `services/order` for §D1, and carrying it further means carrying it forever.

Strictness on the cart contract is **two-sided**: Order asserts its own cart and order responses
against these schemas (`services/order/src/__tests__/cart-order-contract.int.test.ts`), so an
additive server field stops being silent and starts failing a backend test beside the change
that caused it — which is the point. Nothing currently sends extras, so the change is inert on
the day it lands and load-bearing afterwards.

## I. Decisions

| # | Decision | Why |
|---|---|---|
| 1 | Steps derived client-side from four statuses | §A1 — `AWAITING_PAYMENT` proves the reservation; sub-events cost a migration |
| 1a | Cold-loaded `CANCELLED` names no failed step | §A1 — the status cannot distinguish the two causes, and guessing states a falsehood |
| 2 | The mapping is a pure module | §A2 — one place knows the saga; the component knows nothing |
| 3 | Stream writes the query cache; page reads the cache | §B1 — one source of truth, and fallback is a flag on the same query |
| 3a | `setQueryData` never creates an entry | §B1 — the first frame beats the GET, and a `{status}`-only order renders lines-less |
| 4 | Ladder: refresh once, poll after 3 errors, stop on terminal | §B2 — EventSource hides status codes; a 404 stream must not retry forever |
| 4a | Never SSE and polling together | §B2 — parallel polling hides a totally broken stream |
| 4b | Rung 1 closes, refreshes, reopens | §B2 — otherwise EventSource's own ~3s reconnect races the refresh and burns a rung |
| 5 | Frames read via `addEventListener("status")`, not `onmessage` | §B3 — the service sends a NAMED event; `onmessage` would never fire |
| 5a | `EventSource` injected via a factory | §B3 — undefined in jsdom *and* in Node 22, and an untestable ladder is an unverified ladder |
| 6 | Colour is never the only state channel | §C — the design language encodes state in colour; a11y forbids relying on it |
| 6a | Reduced motion removes the pulse, substitutes nothing | §C |
| 7 | `GET /orders` added to the Order service | §D1 — history needs it; a client-side order log would be fiction |
| 7a | No gateway change | §D1 — `RULES` is a permission allowlist; ownership belongs to the service |
| 7b | 50 rows, no cursor | §D2 — a documented ceiling beats half a pagination |
| 8 | `HttpError.body`, best-effort, never throws | §E1 — closes 8b's §D1 without changing what code branches on |
| 9 | Playwright local-only | §F4 — a compose-backed CI lane is its own slice |
| 10 | nginx in the prod overlay only; `proxy_buffering off` | §G — buffering silently freezes the tracker |

## Done when

- [ ] The tracker animates `PENDING → AWAITING_PAYMENT → CONFIRMED` live in a browser, with no
      reload, on a real compose stack.
- [ ] A forced payment failure shows the compensation path and `CANCELLED`.
- [ ] Killing the stream mid-saga (stop the order service's stream, or block SSE) lands on
      polling and the page still reaches its terminal state.
- [ ] `/orders` lists the caller's orders and nobody else's, proven by an integration test.
- [ ] The tracker is operable and comprehensible with a keyboard and a screen reader, and still
      static under `prefers-reduced-motion`.
- [ ] Three Playwright walks green locally against compose.
- [ ] `docker compose -f docker-compose.yml -f docker-compose.prod.example.yml up` serves the
      storefront through nginx, including a live tracker through the proxy.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm -r build` and the full test suite
      clean — lint included per 7c's lesson.
- [ ] Every item in §H closed.

## Risks

**The tracker looks finished but is not live.** Every gate in this repo — typecheck, lint, jsdom
tests — passed over 8a's permanently-dark palette and its JSON-instead-of-app bug, and over 7c's
entirely non-functional tracing. A green suite proves nothing about liveness here. The
acceptance walk on a real stack is the gate that counts, and it must include watching a
transition arrive without a reload.

**nginx buffering.** §G. It fails only in the packaged shape, which is the shape least often
run.

**Scope drift through the a11y sweep.** "Accessibility" can absorb an unbounded redesign. §C
names the surfaces; anything else is a finding for the backlog, not this slice.
