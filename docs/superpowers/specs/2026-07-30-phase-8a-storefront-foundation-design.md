# Phase 8a · Storefront foundation + catalogue — Design (child spec)

> Phase 8 (Storefront, L) is decomposed into three slices — **8a foundation + catalogue**
> (this doc), 8b auth + cart + checkout, 8c order-pipeline tracker + polish. See
> `docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md` §Phase 8 and the umbrella's
> §Phase 8 · Storefront (design), which locks the stack, flows, design language and DoD.

## Purpose

Seven phases built a system with no face. 8a puts the first one on it: a real Vite + React
app in the workspace, talking to the gateway and nothing else, rendering the catalogue that
Catalog already serves.

The slice is deliberately the thinnest vertical that proves the seam. Everything downstream —
auth, cart, checkout, the saga tracker — rides on the same three things 8a establishes: how
the app joins the workspace, how it reaches the gateway, and how a gateway response becomes a
typed value the UI can trust. Get those wrong and every later slice inherits it.

## Scope

**In.** `apps/web` added to the pnpm workspace (Vite + React 19 + TypeScript + Tailwind).
Read-API DTOs added to `packages/contracts`, with Catalog asserting its own responses against
them. A gateway client that validates every response at the boundary. Home grid and product
detail, each with loading, error and empty states. Design tokens lifted from the approved
prototype. Component tests (Vitest + RTL) wired so one `pnpm vitest run` covers them.

**Out.** Auth, cart, checkout (**8b**). SSE order tracker, order history, a11y sweep,
`prefers-reduced-motion`, Playwright, Dockerfile and prod compose profile (**8c**). Stock
display (§C3). A dual ESM+CJS contracts build (§A1 — the requirement is withdrawn, with
evidence).

**No backend change**, with one exception that adds only test assertions: Catalog gains
contract tests (§B2). No route, handler, schema or config in any of the eight services is
modified, so 8a cannot regress the system it renders.

## Preconditions — 8a implements on top of 7d, not beside it

This spec is committed on a branch off `origin/main`, which does **not** contain Phase 7d
(PR #7, open as a draft). That is fine for a documentation commit and wrong for the
implementation, because the two slices edit the same two files:

| File | 7d does | 8a does |
|---|---|---|
| `vitest.config.ts` | added the `infra/**` glob | replaces it with `vitest.workspace.ts` (§E) |
| `eslint.config.js` | added a `k6/**` block | adds an `apps/web` block (§E) |

Left unstated, the likeliest conflict resolution silently drops 7d's `infra` project and
re-creates precisely the uncovered-suite gap 7d existed to close. So:

- **8a implementation starts from a base that contains 7d** — either 7d's head, or `main`
  once #7 merges. The latter is preferred, and keeps the one-open-PR policy intact.
- **`vitest.workspace.ts` must carry an `infra` project forward**, not just `packages`,
  `services` and the new `apps/web`. §E's "the existing three projects" counts 7d's infra
  glob; on this spec's own base there are only two, which is the tell that the base is wrong
  for implementation.

## A. What the roadmap got wrong, and what replaces it

### A1. The dual ESM+CJS contracts build is not needed, and never was

The roadmap opens 8a with "**contracts dual ESM+CJS build FIRST, CI-gated** (gate = ALL
consuming services stay green)", and the umbrella DoD explains why: "so the ESM/Vite app can
import the (CJS) contracts cleanly."

Both halves of that premise are false, and the code says so out loud:

- `packages/contracts/package.json` sets `"main": "src/index.ts"` and `"types":
  "src/index.ts"` — it resolves to **TypeScript source**, not to CJS output.
- Every service runs `tsx src/main.ts`. Nothing in the repo imports `contracts/dist`; the
  `build` script emits output that no consumer reads.
- This is deliberate and documented. Every service Dockerfile carries the comment: *"Runtime
  executes the TypeScript entrypoint directly via tsx (see CMD), so there is NO tsc build
  step: @ecom/shared and @ecom/contracts are consumed as source through their package
  `main: src/index.ts`."* It holds in production, not just in dev.

So contracts is never consumed as CJS by anyone, and Vite resolves a linked workspace package
of TypeScript source the same way the services do.

**Replacement:** add `apps/*` to `pnpm-workspace.yaml` and import `@ecom/contracts` source
directly. The CI gate the roadmap wanted becomes trivially green because **no service's
resolution changes at all** — which is the point. Switching every consumer to built output
would contradict a deliberate architecture decision, add a build step before any service can
run, and put the riskiest possible change at the front of a frontend slice.

Residual risk is confined to Vite: a symlinked TS workspace package can need `optimizeDeps`
or `preserveSymlinks` tuning. That risk is ours alone and costs a config line; the discarded
alternative's risk was spread across eight services.

**Amendment recorded** (§G1): the umbrella DoD line and the roadmap 8a line are corrected in
this slice, following the 7a precedent where spec-vs-code drift was resolved by ruling on the
docs.

### A2. The catalogue cannot show stock

The approved prototype renders stock on every card — "In stock", "Low · 3 left", "Sold out" —
and gives products a `sku`, a `lede` and a `specs` table. The backend serves none of it:

- `GET /products` returns `{id, type, name, price, version}`. `GET /products/:id` adds
  `attributes`. There is no sku, lede or specs.
- **Stock lives in Inventory, and the gateway has no `/inventory` mount** — it proxies order,
  catalog and payment only (`services/gateway/src/app.ts:216-237`). This was confirmed during
  7d, where it is the reason C4 had to stop `order` to produce gateway-visible errors.

Since the storefront talks only to the gateway (umbrella decision #7), stock is unreachable.
**8a therefore omits it.** Availability is proven at checkout by the reservation step, which
is 8b/8c's story. Adding a gateway inventory route or projecting availability into Catalog are
both real options, and both are backend work that does not belong inside a frontend slice.

## B. Contracts, and preventing drift for real

### B1. Two read DTOs, because there are two shapes

`packages/contracts` currently exports event payloads only — there is no DTO for the read API
the storefront consumes. 8a adds them:

- `ProductListItem` — `{ id, type, name, price, version }`, what `GET /products` returns.
- `ProductDetail` — the same plus `attributes`, what `GET /products/:id` returns.

Two schemas, not one with an optional field, because the routes genuinely differ and an
optional `attributes` would let a detail view silently render nothing when the field goes
missing.

`type` is the union `ELECTRONICS | CLOTHING | FURNITURE | MOTORBIKE`, verified against
`services/catalog/src/attributes.ts`.

`attributes` stays `z.record(z.unknown())` at the boundary. Catalog already validates
type-specific attributes with per-type schemas it owns; restating them in a shared package
would create a second source of truth to keep in sync, which is the drift this section exists
to prevent.

`version` is carried in both DTOs though no 8a view renders it. It is Catalog's optimistic
concurrency counter and the field its projection ordering keys on, so having it at the
boundary makes a stale-cache question answerable later without a contract change.

`price` is **integer minor units** — "Widget" is `900`, meaning $9.00. Formatting divides by
100 at the presentation layer and nowhere else.

`GET /products` takes **no parameters**: it is `findMany({ orderBy: { createdAt: "asc" } })`
with no take or skip, so the whole catalogue arrives in one response. 8a renders all of it.
Pagination is a Catalog change and is out of scope; the client must not send `?limit=` and
imply otherwise.

### B2. The client validating alone does not prevent drift

The umbrella's "no contract drift" item is satisfied on paper by importing shared DTOs and
validating responses. It is not satisfied in practice: if Catalog changes its response shape,
only the storefront finds out, at runtime, in a browser, as a blank grid.

So the schema is pinned from **both** ends. **Catalog's own integration tests assert its
responses satisfy the shared schemas.** Drift then fails a backend test in CI, next to the
change that caused it, instead of surfacing as a frontend bug days later.

This is the only change 8a makes to a service, and it adds assertions to existing tests —
no production code.

### B3. Schema mismatch is a distinct failure

The client distinguishes three failures because they need three responses:

| Failure | Meaning | Response |
|---|---|---|
| Network | Gateway unreachable | Retryable; "try again" affordance |
| HTTP status | 4xx/5xx from the gateway | Error state with the status |
| **Schema mismatch** | **Backend drift — a bug** | **Own error type, loud in dev** |

Collapsing the third into a generic error is how a contract violation gets mistaken for an
empty catalogue. It renders an error, never an empty grid.

## C. The app

### C1. Same-origin, always

The browser never addresses the gateway directly. Vite's dev server proxies `/products` (and
later `/cart`, `/orders`, `/auth`) to the gateway; the 8c production image will be nginx
serving the bundle and proxying the same prefixes.

This is load-bearing for three reasons:

1. **The gateway has no CORS middleware at all** — verified: nothing in
   `services/gateway/src` references cors or `Access-Control`. A cross-origin fetch from
   `:5173` is simply blocked. Same-origin needs no gateway change.
2. **8b's cookies work with `SameSite=Lax`.** Cross-origin would force `SameSite=None;
   Secure`, which does not survive plain `http://localhost` — a trap that would surface only
   once auth landed.
3. **The gateway URL never enters the bundle.** It configures the proxy, which is dev-server
   and nginx config. That satisfies the DoD's "env-based config (Gateway URL)" and its
   sibling "zero secrets in the bundle" more literally than a `VITE_` variable would.

`/products` is mounted `authOptional`, so the catalogue is genuinely public and 8a needs no
auth to render it.

### C2. Layers

- **`src/api/`** — one `request()` performing fetch → status mapping → zod parse, plus a
  module per resource (`products.ts`). The only code that knows HTTP exists. Everything above
  it receives typed values or typed errors.
- **`src/routes/`** — `Home` and `Product`.
- **`src/components/`** — presentational primitives. No fetching.

React Query holds server state. **No global store**: the only client state 8a has is the
current category filter, and cart state arrives in 8b. Inventing a store now would be
speculative structure for a need that has not appeared.

**The retry policy is pinned, not defaulted.** React Query retries a failed query three times
for *every* error type. Left alone that contradicts §B3 outright: a schema mismatch — a bug —
would be retried three times before surfacing, and a 404 would be retried for a product that
will never exist. The query client therefore retries **network failures only**, never a
schema mismatch and never a 4xx. This is the kind of default that silently makes a drift
alarm slower and quieter, which is the opposite of what §B3 is for.

### C3. Views

**Home** — hero, category filter chips, product grid. **Product detail** — figure, name,
price, and the `attributes` map rendered as a key/value table, which is the honest substitute
for the prototype's invented `specs`.

Every async view has three states, per the DoD: loading (skeletons matching the card
geometry, not a spinner), error (§B3's taxonomy), and empty (a catalogue with no products is
a real state, and after 7d's cleanup the dev database can genuinely be near-empty).

**A 404 on product detail is its own case**, distinct from all three. It is reachable without
anything being broken — a stale link, a shared URL, a product removed between the list
rendering and the click — so it renders a "product not found" view with a route back to the
catalogue, never a generic error and never an empty page.

**Rendering `attributes` safely.** The map is `z.record(z.unknown())` (§B1), so its values are
genuinely unknown at compile time. The table renders **primitive values only** — string,
number, boolean — and skips anything else rather than emitting `[object Object]`. And because
these strings originate from an API rather than from the app, **no API-sourced value is ever
passed to `dangerouslySetInnerHTML`**; React's default escaping is the whole XSS defence here
and nothing may opt out of it. A Content-Security-Policy belongs with 8c's nginx, which is
where the app first gets served by something that can set headers.

## D. Design system

Tokens are lifted **verbatim** from the approved prototype
(`https://claude.ai/code/artifact/d172bc7c-53ef-4d86-9872-a7e89f2bf48e`) into Tailwind's theme
as CSS variables — the palette (`--paper #F1F1F4`, `--surface #FFFFFF`, `--ink #1D1D1F`,
`--muted #6E6E76`, `--line #E8E8ED`), the state colours (`--live #B26A12`, `--ok #2E7D46`,
`--fail #C0392B`, `--focus #2F73E8`), radii 12/16/24/pill, both shadow levels, and the sans
and mono stacks. The prototype is the reference and already supplies exact values; there is
nothing to reinterpret.

**Mono with `tabular-nums` for every datum** — prices, ids, versions — per the design
language.

**Dark values ship in 8a; the toggle does not.** The prototype supplies a complete dark
palette, so encoding it in the token layer now is nearly free, whereas retrofitting a token
layer later is the kind of rework that gets skipped. Media query only in 8a; the toggle is 8c
polish, alongside the `prefers-reduced-motion` block the prototype also already provides.

**8a is deliberately monochrome.** The design language reserves colour to encode saga state —
amber in-progress, green confirmed, red cancelled. There is no saga in 8a, and spending those
three colours on a product grid would burn the encoding before the tracker that needs it
exists.

Primitives: `Card`, `Badge`, `Price`, `Skeleton`, `EmptyState`, `ErrorState`, `Button`, and
the four category silhouettes as inline SVG keyed off the `type` union — a 1:1 match with the
prototype's four.

## E. Testing and CI

`pnpm typecheck` and `pnpm -r build` are recursive, so `apps/web` is covered **automatically**
once it joins the workspace: CI typechecks it and builds the bundle with no workflow edit.

Tests are the gap. Root `vitest.config.ts` includes only `packages/**`, `services/**` and —
**once 7d is in the base, per §Preconditions** — `infra/**`. `apps/web` tests would silently
not run, and they need `jsdom`, which the existing node-environment suites must not inherit.

**A `vitest.workspace.ts`** resolves both: every existing glob keeps its current config
verbatim as its own project, and `apps/web` gets jsdom plus an RTL setup file. One
`pnpm vitest run` then covers everything, locally and in CI, with no new workflow step. The
`infra` project is explicitly part of "every existing glob" — dropping it is the failure mode
§Preconditions exists to prevent.

The rejected alternative is a bespoke `pnpm --filter @ecom/web test` CI step, which leaves
`pnpm vitest run` quietly missing a project for anyone running it locally. That is precisely
the silent-gap class that produced 7d's vacuous `pnpm -r typecheck` gate, where the command
reported "10 of 11 workspace projects" and nobody noticed infra was unchecked.

`eslint.config.js` gains a block for `apps/web`: JSX parsing and `react-hooks` rules.
Prettier already covers the tree.

**What gets tested**

| Test | Why it can fail |
|---|---|
| Boundary rejects a malformed payload | The drift alarm — remove the zod parse and this must fail |
| Three async states per view | Loading/error/empty are DoD items, not decoration |
| `Price` formats minor units | `900` must render `$9.00`, never `$900` |
| `type` → silhouette mapping | All four types resolve; an unknown type degrades, not crashes |
| Catalog responses satisfy the shared schemas (§B2) | Backend-side drift alarm |

No Playwright — 8c. Whether it runs in CI or locally stays parked, per the roadmap.

## F. Decisions

| # | Decision | Why |
|---|---|---|
| 1 | 8a is foundation + catalogue only | The dual-build question and the workspace seam are the risky parts; resolve them before UI volume |
| 2 | Contracts consumed as source; no dual build | §A1 — the stated premise is false and the alternative regresses eight services |
| 3 | React 19 | The umbrella says "latest at build time". Router 7 and Query 5 are believed to support it; the plan pins and records the exact resolved versions rather than trusting this line |
| 4 | No stock in the catalogue | §A2 — unreachable through the gateway |
| 5 | Same-origin via proxy, not CORS | §C1 — no backend change, and 8b's cookies work |
| 6 | Catalog asserts the shared schemas | §B2 — client-only validation does not prevent drift |
| 7 | `vitest.workspace.ts`, not a bespoke CI step | §E — avoids a silent local gap |
| 8 | Dark tokens now, toggle in 8c | Free from the prototype; retrofitting a token layer is not |
| 9 | Monochrome catalogue | Colour is reserved to encode saga state |

## G. Documentation amendments

Three locked statements are contradicted by evidence and are corrected as part of this slice,
following the 7a precedent (spec-vs-code drift resolved by ruling on the docs).

1. **Umbrella DoD — "`packages/contracts` builds dual ESM+CJS so the ESM/Vite app can import
   the (CJS) contracts cleanly."** Amended: contracts is consumed as TypeScript source by
   every consumer in dev and production, as each service's Dockerfile states. `apps/web` does
   the same through the workspace link.
2. **Roadmap 8a — "contracts dual ESM+CJS build FIRST, CI-gated."** Amended to workspace
   wiring. The gate it describes is vacuous because no service's resolution changes.
3. **Umbrella DoD — "Env-based config (Gateway URL)."** Amended: satisfied at the proxy
   layer rather than as a bundled `VITE_` variable, which is strictly better against the
   sibling "zero secrets in the bundle" requirement.

Parked decisions resolved: React 19 (#3), stock deferred (#4). Playwright-in-CI remains
parked for 8c.

## H. Definition of Done

- [ ] `apps/*` in `pnpm-workspace.yaml`; `apps/web` builds, typechecks and lints via the
      existing recursive root scripts.
- [ ] `@ecom/contracts` exports `ProductListItem` and `ProductDetail`; **Catalog's own tests
      assert its responses satisfy them**.
- [ ] Every gateway response is zod-validated at the boundary; schema mismatch is a distinct,
      loud error, never an empty grid.
- [ ] Home grid and product detail each render loading, error and empty states.
- [ ] Design tokens are declared **once**, as CSS variables carrying the prototype's values
      including the dark set — no hard-coded colour, radius or shadow literal anywhere in a
      component. (Fidelity to the prototype is a review-time judgement; single-declaration is
      the part a reviewer can actually check.)
- [ ] `pnpm vitest run` covers `apps/web` through `vitest.workspace.ts`, with the existing
      three projects unchanged.
- [ ] Browser talks only to same-origin paths; no CORS middleware added to the gateway; no
      gateway URL in the bundle.
- [ ] No production code changed in any of the eight services.
- [ ] Umbrella DoD and roadmap amended per §G.

### Known limitations carried in

- **No pagination.** `GET /products` serves the entire catalogue in one response, so the grid
  is unbounded. Acceptable at demo scale; a Catalog change if it ever is not.
- **No stock.** §A2.
- **No sku / lede / specs.** The prototype invents them; the detail view renders the real
  `attributes` map instead.
- **Vite + symlinked TS workspace package** may need `optimizeDeps` or `preserveSymlinks`
  tuning. Contained to `apps/web`'s config.
