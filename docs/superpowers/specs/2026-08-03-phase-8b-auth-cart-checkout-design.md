# Phase 8b · Storefront auth + cart + checkout — Design (child spec)

Parent: `docs/superpowers/specs/2026-07-18-microservices-streaming-rebuild-design.md` §Phase 8
Roadmap: `docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md` §Phase 8 Slices, slice 2
Predecessor: `docs/superpowers/specs/2026-07-30-phase-8a-storefront-foundation-design.md`

## Purpose

Turn 8a's read-only catalogue into a storefront that can transact: register, log in, collect
a cart, place an order, and see what happened to it.

Every backend capability this needs already exists. The gateway owns cookie translation and
CSRF, Identity owns credentials, and the Order service owns the cart and the place-order
transaction. **8b is a frontend slice.** It writes no service production code.

## Scope

**In:** register and login through the gateway; the session the SPA infers from the server;
protected routes; the cart page and its mutations; checkout; a static order-confirmation view;
`CartSchema` and `OrderSchema` in contracts, asserted by Order's own tests.

**Out:** the live order tracker and its polling fallback (8c owns both — see §D3); order
history (8c); a11y sweep and `prefers-reduced-motion` (8c); Playwright e2e (8c); the
production Dockerfile and nginx (8c); guest carts (§C1); address, shipping and any real
payment UI — the saga charges a simulated gateway off the cart total and needs no input.

## Preconditions

8a is merged (`ecd9886`). This slice depends on three things it established:

1. **Same-origin `/api/*`.** The browser reaches the gateway through a proxy that strips the
   prefix. This is what makes `SameSite=Lax` cookies work at all — the reason 8a's spec §C1
   insisted on a proxy over CORS, now actually load-bearing.
2. **`request()` as the only HTTP-aware module**, with a typed error taxonomy. 8b extends it
   rather than working around it.
3. **Backend-asserted contracts.** 8a proved the pattern with Catalog; 8b repeats it for the
   cart and order shapes.

---

## A. What the backend already provides

Verified by reading the services, not assumed from the roadmap.

| Capability | Endpoint | Owner |
|---|---|---|
| Register | `POST /auth/register` → 201 `{userId}`, **no tokens**; 409 on duplicate email | gateway → identity |
| Login | `POST /auth/login` → sets cookies, returns `{ok:true}` | gateway → identity |
| Refresh | `POST /auth/refresh` → cookie in, cookies out | gateway → identity |
| Logout | `POST /auth/logout` → clears cookies | gateway → identity |
| Read cart | `GET /cart` → `{userId, items:[{productId, quantity}]}` | order |
| Add item | `POST /cart/items` → 201 `{productId}` | order |
| Change quantity | `PATCH /cart/items/:productId` | order |
| Remove item | `DELETE /cart/items/:productId` | order |
| Place order | `POST /orders` → 201 `{orderId, status, totalPrice, items[]}` | order |
| Read order | `GET /orders/:id` → `{id, userId, status, totalPrice, items[], createdAt}`; 404 for someone else's | order |

Two behaviours worth stating because they are easy to invert: `POST /cart/items`
**increments** an existing line (`update: { quantity: { increment } }`), so adding the same
product twice adds to it rather than replacing it; `PATCH /cart/items/:productId` **sets** the
quantity, and setting it to 0 removes the line. The cart page's stepper is therefore a PATCH,
never a repeated POST.

`/cart` and `/orders` are mounted `authRequired` at the gateway. Neither appears in the authz
`RULES` table, so authentication is the whole check and ownership stays in Order — which
scopes by the caller and reports another user's order as **404, not 403**, so ids stay
unenumerable.

### A1. There is no `GET /auth/me`, and 8b does not add one

The access token is httpOnly; JavaScript cannot read it. The only readable signal is the
`XSRF-TOKEN` cookie, which is non-httpOnly by design so the client can echo it.

Inferring the session from that cookie is tempting and wrong: the gateway sets it on login and
refresh and clears it on logout and on a rejected refresh, but nothing clears it when the
refresh token simply expires server-side. The UI would show a signed-in header until the next
401 contradicted it.

**The session is whatever `GET /cart` says.** 401 is logged out, 200 is logged in, and the
payload is the cart the header badge needs anyway — one request answers both questions. An
expired access token resolves itself inside that request through §B2's refresh, so the answer
that comes back is already correct.

**The probe must not drag an anonymous visitor into the refresh path.** `GET /cart` is
`authRequired` at the gateway, so a logged-out visitor gets 401 — and §B2 turns every 401 into
a refresh, which would fail and route them to `/login`. Left there, loading the public
catalogue would bounce an anonymous user to a login form and burn two of the ten permitted
auth requests per minute doing it. That regresses the thing 8a shipped.

Two rules close it:

1. **No `XSRF-TOKEN` cookie means no session to refresh.** Skip the refresh entirely and
   resolve "logged out". This reads the cookie as a *negative* signal, which is sound: the
   gateway only ever sets it alongside a session. It does not contradict the paragraph above,
   which refuses to trust its *presence* as proof of one.
2. **A failed refresh on the session probe resolves to "logged out", not a redirect.**
   Redirecting is the response to an unauthenticated *protected route or mutation*, never to
   the question "is anyone logged in?".

Adding `GET /auth/me` would be the conventional choice and is a reasonable 8c change if order
history wants a display name. It is not worth breaking this slice's frontend-only property.

---

## B. The auth layer

### B1. `request()` grows, and stays the only HTTP-aware module

Signature becomes `request<T>(path, schema, init?)`. Three additions:

- **Credentials.** `fetch` defaults to `same-origin`, and 8a made every call same-origin, so
  cookies ride without configuration. Stated here because it looks like an omission otherwise.
- **CSRF.** On `POST`/`PATCH`/`DELETE`, read `XSRF-TOKEN` and send it as `X-CSRF-Token`. The
  gateway's guard compares the two and rejects a mismatch with 403. If the cookie is absent
  there is no session at all, which is a client-side fact — raise the typed error immediately
  rather than spending a round trip to be told. The exempt list is
  `/auth/(login|register|refresh)` and the payment webhook, so **`/auth/logout` is not exempt**
  and needs the header like any other mutation — the one call where a reader is likely to
  assume otherwise.
- **401 handling.** See B2.

### B2. One refresh at a time, and exactly one retry

This is the part of the slice most likely to look correct and behave badly.

Identity rotates refresh tokens and detects reuse **family-scoped**: presenting a rotated-away
token invalidates the whole family. 7a added a grace window so an honest double-refresh no
longer logs the user out, but that is a safety net, not licence to fire concurrent refreshes.
Separately, `/auth/*` is rate-limited to **10 requests per minute**. A page that issues five
parallel queries after the access token expires would fire five refreshes, burn half the
budget, and lean on the grace window to avoid destroying its own session.

So: a module-level single-flight promise. The first 401 starts the refresh; every other 401
awaits the same promise; each request then retries **once**. A second 401 after a successful
refresh is a real failure and propagates — no loop, under any circumstance.

A failed refresh clears the cached session and routes to `/login`. The gateway has already
cleared the cookies at that point, so the client is only catching up with a decision the
server made.

**The test asserts the number of refresh calls, not just the eventual outcome.** An
implementation that refreshes per-request passes every outcome-shaped assertion.

### B3. Registering does not sign you in

`POST /auth/register` returns 201 `{userId}` and **no tokens**, and the gateway does not set
cookies on that path — unlike login, which does. A user who registers is therefore still
anonymous, and any flow that assumes otherwise will send them straight into a 401.

**After a successful register, land on the login form with the email prefilled.** The
alternative, firing a follow-up `POST /auth/login` with the credentials still in memory, is
smoother but spends a second of the ten-per-minute auth budget, adds a failure mode with
nothing useful to say when it fails ("registered, but could not sign in"), and keeps a
password in memory past the point it was needed. Prefilling costs one field and leaves the
user in a state they can see and act on.

**409 `email already registered`** is the likeliest registration failure and belongs on the
email field, not in the generic error state — the same argument §D1 makes for `cart is empty`.
It also wants a link to sign in instead.

### B4. Auth errors are not the generic taxonomy

8a's three errors stay. 8b adds the distinction between *unauthenticated* (no session, or one
that could not be refreshed → go to `/login`) and *rejected credentials* (a 401 from
`/auth/login` itself → "email or password is wrong", stay on the form). Collapsing them sends
a user with a typo into a redirect loop.

`429` from the auth limiter gets its own message. It is reachable by a human retrying a
password, and "too many attempts, wait a minute" is actionable where "the store answered 429"
is not.

---

## C. Cart

### C1. Add-to-cart requires a session

`Cart.userId` is the primary key. There is no anonymous cart and 8b does not invent one: a
local guest cart means a second cart implementation plus a merge policy (sum or replace? a
product deleted since? repriced since?), all of it frontend complexity for a learning platform
whose backend deliberately models a server cart.

Clicking add-to-cart while logged out routes to `/login` with a return-to, and lands back on
the product afterwards. The button is present and honest rather than hidden — hiding it makes
the catalogue read as a brochure.

### C2. The cart response carries no names and no prices

`GET /cart` returns product **ids and quantities only**. Rendering a cart therefore requires
the catalogue.

The cart page joins against `listProducts()`, which 8a already fetches for Home, React Query
already caches, and which returns the entire catalogue in one response — so the join costs no
extra request. `/products` is mounted `authOptional`, so that join keeps working while logged
out and while a session is expiring, which matters because the same join renders the order
confirmation. A product absent from that list (deleted since it was added) **degrades to its
id**; it does not blank the row or crash the page. That case is reachable without anything
being broken.

### C3. The cart total is an estimate and says so

Because prices come from the catalogue join rather than the cart, the displayed total is a
client-side computation over data that may be stale. The authoritative price is applied
server-side inside `POST /orders`, from Order's catalog read-model, at the moment of placing.

If a price changed in between, **the charged total differs from the one shown**. The cart
labels its total as an estimate, and the confirmation view shows the order's own
`unitPrice` values, which are the prices actually captured. Presenting the cart estimate as
final would be the kind of quiet lie that erodes trust in the whole app.

---

## D. Checkout and confirmation

### D1. Two failure modes that are not errors

`POST /orders` has three outcomes beyond success, and two of them are ordinary:

- **400 `cart is empty`** — reachable by placing twice, or in another tab. Route back to the
  cart with an explanation.
- **422 `unpriced product`** — Order's catalog read-model has no price for a product in the
  cart, naming the id. The projection is eventually consistent, so this is reachable for a
  product added to the catalogue moments ago. Name the product and offer to remove it.
- **500** — the generic error state.

Rendering the first two as "something went wrong" would strand a user who could have fixed it
in one click.

### D2. Confirmation

201 routes to `/orders/:id`, which renders the order's items at their captured `unitPrice`,
the total, and the status as returned.

**Checkout invalidates the cart query.** `POST /orders` clears the cart *inside the same
transaction* that writes the order, so the server cart is empty the moment the call returns.
Without invalidation the header badge keeps showing the old count until something else
refetches — a stale number on the screen immediately after the action that emptied it. Product names come from the same catalogue join as the
cart, with the same id fallback — an order outlives the product it references.

### D3. Status is static in 8b

The order is `PENDING` at 201 and the saga moves it to `CONFIRMED` or `CANCELLED`
asynchronously. 8b renders the status it fetched, once.

Liveness is 8c's whole subject — the SSE tracker is the phase's signature element and polling
is its documented fallback. Building a poller here means writing it now and deleting it there,
and a wrong interval is easy to ship unnoticed. 8b instead leaves 8c a real page to upgrade,
with the status block as the seam.

Consequence, stated plainly: in 8b a user who wants to know whether their order confirmed must
reload. That is acceptable for one slice and is the first thing 8c fixes.

---

## E. Contracts and drift

`packages/contracts/src/http/order.ts` gains `CartSchema`, `CartItemSchema`, `OrderItemSchema`,
`PlacedOrderSchema` and `OrderDetailSchema`, exported from the package index.

**Two order schemas, because Order returns two shapes** — the same situation 8a met with the
catalogue (§B1 there), and it must not be modelled as one:

| | `POST /orders` (201) | `GET /orders/:id` (200) |
|---|---|---|
| identifier | `orderId` | `id` |
| `userId` | absent | present |
| `createdAt` | absent | present |
| `status`, `totalPrice`, `items[]` | present | present |

A single schema forces either an optional identifier — which defeats the point, since a
missing id would parse clean — or a rename that one of the two endpoints will fail. Both
schemas share `OrderItemSchema` (`productId`, `quantity`, `unitPrice`).

As in 8a, **the Order service asserts its own responses against them** in a new integration
test. A client that validates alone discovers drift in a browser; a backend that validates
itself fails a test in the commit that caused it. That test must be shown to fail when a field
is renamed, not merely to pass.

`status` is modelled as a string enum of the statuses Order can actually return
(`PENDING`, `AWAITING_PAYMENT`, `CONFIRMED`, `CANCELLED`), so an unrecognised status fails
validation loudly rather than rendering as a blank badge.

---

## F. Testing

Component tests (jsdom, Testing Library) for:

1. Add-to-cart while logged out redirects to `/login` and returns to the product after.
2. A mutation sends `X-CSRF-Token` matching the `XSRF-TOKEN` cookie.
3. **Concurrent 401s trigger exactly one `POST /auth/refresh`**, and each request retries once.
4. A second 401 after refresh propagates instead of looping.
5. The cart joins names from the catalogue and degrades to the id for a missing product.
6. `cart is empty` and `unpriced product` each render their own recovery, not the error state.
7. A rejected login stays on the form; an unauthenticated session redirects.
8. **An anonymous visitor loading a public page issues no `POST /auth/refresh` at all** and is
   not redirected — the regression §A1 exists to prevent.
9. A successful register lands on the login form with the email prefilled; a 409 shows on the
   email field with a link to sign in.
10. Both order schemas parse their own endpoint's real response, and `PlacedOrderSchema`
    rejects a `GET /orders/:id` body (and vice versa) — proof the two shapes were not
    collapsed.

Plus the Order contract test in §E.

**A browser pass is required before the slice is called done**, not optional polish. 8a's two
worst defects — a page serving raw JSON, and a permanently-dark palette — passed typecheck,
lint, format and 27 green jsdom tests. The flows to walk: register, log in, add to cart from a
cold session, place an order, and confirm cookies are set and `X-CSRF-Token` rides the
mutations.

---

## G. Decisions

| # | Decision | Why |
|---|---|---|
| 1 | Frontend-only; no service production code | Every capability exists; 8a proved the pattern |
| 2 | Session = `GET /cart`, not the XSRF cookie | §A1 — the cookie outlives an expired refresh token |
| 3 | No `GET /auth/me` | §A1 — not worth breaking the frontend-only property |
| 4 | Gate add-to-cart behind login | §C1 — no anonymous cart exists to fill |
| 5 | Single-flight refresh, retry once | §B2 — reuse detection and a 10/min limit |
| 5a | No `XSRF-TOKEN` ⇒ skip refresh, resolve logged-out | §A1 — otherwise anonymous browsing redirects to `/login` |
| 5b | Register lands on the login form, email prefilled | §B3 — register returns no tokens; auto-login buys little and can fail mutely |
| 5c | Two order schemas, not one | §E — `POST` and `GET` genuinely differ, including the id's key |
| 6 | Cart total is an estimate, labelled | §C3 — pricing is authoritative only at place time |
| 7 | Catalogue join for names, id fallback | §C2 — cart and order carry no names |
| 8 | Static status; no polling | §D3 — liveness is 8c's subject, whole |
| 9 | Order asserts its own cart/order shapes | §E — drift fails beside its cause |

---

## H. Definition of Done

- [ ] Register, login and logout work end-to-end against the real gateway, with register
      landing on the prefilled login form.
- [ ] Protected routes redirect when unauthenticated and return after login.
- [ ] **Anonymous browsing of the catalogue triggers no refresh and no redirect.**
- [ ] Cart add / quantity change / remove, each invalidating the cart query.
- [ ] Checkout places an order and routes to a confirmation view.
- [ ] `cart is empty` and `unpriced product` each have their own recovery path.
- [ ] Concurrent 401s produce exactly one refresh, asserted by call count.
- [ ] No token, secret or gateway URL in the bundle; the browser calls only `/api/*`.
- [ ] `CartSchema`, `PlacedOrderSchema` and `OrderDetailSchema` in contracts, asserted by
      Order's own test, proven to fail on a renamed field.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm -r build` all clean.
- [ ] Browser pass walked and recorded.

### Known limitations carried in

- Order status is static until 8c.
- The cart total can differ from the charged total when a price changes mid-session (§C3).
  **8b does not warn when it does.** Detecting the divergence means carrying the estimate
  across the checkout mutation into the confirmation view — state plumbing for a case that
  needs a price to change inside one session. The cart labels its own total as an estimate and
  the confirmation shows the authoritative one, which is honest without the extra machinery.
  Worth revisiting if 8c's order history makes the estimate worth persisting anyway.
- No guest cart (§C1).
- CSRF tokens remain unbound to a session — a Phase 6 limitation, unchanged here.
- The auth rate limit is 10/min per IP, which a developer hammering login can hit.
