# Phase 6 · Identity + Gateway — Design (child spec)

> Combined 6a+6b spec (user decision): `services/identity` and `services/gateway` land in
> one pass, together with the identity-propagation retrofit across existing services.
> Reference: `docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md` (Phase 6).
> Touches **new** identity + gateway, **Order** and **Catalog** (propagation retrofit),
> **contracts** (`identity.user_registered`), **infra** (compose profiles, keypair).

## Purpose

1. **`services/identity`** — register / login / logout / refresh with **rotation +
   reuse-detection preserved as behavior**, token crypto **replaced**: RS256 JWTs whose
   claims are the identity, never an `x-client-id` header. Full grants model
   (`Role`/`Resource`/`Grant`) with admin CRUD. Emits `identity.user_registered`.
2. **`services/gateway`** — the single sync edge: routing, JWT verify, httpOnly cookies,
   double-submit CSRF, rate-limit, helmet, traceId minting, per-route timeouts +
   circuit breaker, SSE proxying, and RBAC enforcement.
3. **Identity-propagation retrofit** — services stop trusting client-supplied headers.
   The gateway strips inbound identity headers and injects verified ones.

## Scope

**In:**
- `services/identity` (:3006, `identity` DB — already provisioned in
  `infra/postgres/init/01-databases.sql`): `User`, `RefreshToken`, `Role`, `Resource`,
  `Grant`; bcrypt password hashing; RS256 access tokens; opaque rotating refresh tokens;
  grants admin CRUD; outbox → Kafka `identity.events`.
- `services/gateway` (:8000, **no DB, no business logic**): `http-proxy-middleware`
  routes to order/catalog/payment/identity, `opossum` breaker + timeout per upstream,
  cookie set/refresh, double-submit CSRF, `express-rate-limit`, `helmet`, RBAC
  enforcement from a grants snapshot, SSE pass-through.
- Contracts: `IDENTITY_USER_REGISTERED` + payload schema.
- Retrofit: Catalog admin mutations require an injected admin role; Order continues to read
  `x-user-id` but only the gateway may set it; **Order gains ownership scoping on
  `GET /orders/:id` and `/orders/:id/stream`** (§C — closing a latent IDOR that
  authentication would otherwise expose). Prod compose profile publishes the
  gateway port only.

**Out:** OAuth/social login; api_keys port (legacy `apiKey.model` stays unported); admin
UI; email verification / OTP; password reset; a Notification consumer for
`identity.user_registered` (**emit only** — user decision); per-service JWT re-verify
(gateway-injected headers only — see §D).

---

## A. Token crypto (decided: RS256, gateway verifies with the public key)

- **Access token:** RS256 JWT, TTL **15m**, claims `{ sub: userId, role: roleName, iat,
  exp }`. Identity signs with the private key; the gateway verifies with the public key.
  No shared secret exists anywhere, so a gateway compromise cannot mint tokens.
- **Keys:** PEM strings in env — `JWT_PRIVATE_KEY` (identity only), `JWT_PUBLIC_KEY`
  (gateway). Generated once by a committed script
  (`services/identity/scripts/gen-jwt-keypair.sh`, openssl RSA 2048 — the repo has no
  root-level `scripts/`; Notification set the precedent with a per-service `scripts/`) writing to the gitignored per-service
  env files; `docs/infra.md` documents the step. **No JWKS endpoint** — rotation is a
  Phase-7 concern, and a fetch+cache path is runtime surface the MVP does not need.
- **Refresh token:** NOT a JWT. 32 random bytes, base64url. Stored **hashed**
  (sha256) so a database leak cannot resume sessions. TTL **7d**.
- **Legacy replacement (explicit):** the legacy per-user `publicKey`/`privateKey` pair
  (two random hex strings used as HS256 symmetric secrets) is gone, as is `x-client-id`.
  Only the *behavior* — rotation + reuse-detection — is preserved.

## B. Sessions: rotation + reuse-detection (decided: multi-session)

### Data model (`services/identity/prisma/schema.prisma`)

```prisma
model User {
  id        String   @id @default(uuid())
  email     String   @unique
  password  String                  // bcryptjs hash, cost 10
  name      String
  roleId    String
  role      Role     @relation(fields: [roleId], references: [id])
  status    String   @default("ACTIVE")   // ACTIVE | BLOCKED
  createdAt DateTime @default(now())
  sessions  RefreshToken[]
}

// One row per session (device), NOT one per user: a phone login must not evict a laptop.
// `familyId` groups a rotation chain so reuse-detection can revoke exactly that chain.
model RefreshToken {
  id          String    @id @default(uuid())
  tokenHash   String    @unique          // sha256 of the opaque token
  userId      String
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  familyId    String                     // rotation chain id
  revokedAt   DateTime?
  replacedBy  String?                    // id of the row minted by the rotation
  expiresAt   DateTime
  createdAt   DateTime  @default(now())

  @@index([userId])
  @@index([familyId])
}

model Role {
  id     String  @id @default(uuid())
  name   String  @unique               // USER | ADMIN | (any future role)
  grants Grant[]
  users  User[]
}

model Resource {
  id     String  @id @default(uuid())
  name   String  @unique               // e.g. "catalog.product", "payment.refund"
  grants Grant[]
}

model Grant {
  id         String   @id @default(uuid())
  roleId     String
  resourceId String
  action     String                    // read | create | update | delete
  role       Role     @relation(fields: [roleId], references: [id], onDelete: Cascade)
  resource   Resource @relation(fields: [resourceId], references: [id], onDelete: Cascade)

  @@unique([roleId, resourceId, action])
}
```

`ProcessedEvent` + `Outbox` copied from the sibling services (identity is a producer
only, but the outbox is how every service publishes).

### The state machine (`sessions.ts`, pure core over a tx port)

`rotateRefresh(tx, presentedTokenHash)`:

| row state | outcome | effect |
|---|---|---|
| not found | `UNKNOWN` | 401. No side effect (an unknown token proves nothing about a family). |
| `revokedAt != null` | `REUSE` | **Revoke every row in `familyId`** → 401. This is legacy's "refreshTokensUsed" branch, scoped to one chain instead of the whole user. |
| `expiresAt < now` | `EXPIRED` | 401, row revoked. |
| live | `ROTATED` | Mint a new row in the same family, set `replacedBy` + `revokedAt` on the old one, return the new token. |

Rotation happens in **one transaction** so a crash cannot leave two live tokens in a
family. The whole table is the port's concern; the state machine is pure and unit-tested
against a fake tx, matching `transition.ts` / `applyDispatch`.

### Endpoints (identity)

| route | body | result |
|---|---|---|
| `POST /auth/register` | email, password, name | 201 + user row + `identity.user_registered` outbox row, same tx. Duplicate email → 409. Password `z.string().min(8)`, email `z.string().email()`. |
| `POST /auth/login` | email, password | 200 + `{ accessToken, refreshToken, user }`. Bad credentials → 401 (identical message for unknown-email and bad-password). |
| `POST /auth/refresh` | refreshToken | 200 + new pair, or 401 per the table above. |
| `POST /auth/logout` | refreshToken | 204; revokes that session only. |
| `GET /internal/grants` | — | Snapshot `{ role: { resource: [actions] } }` for the gateway (see §C). |
| `GET/POST/PATCH/DELETE /admin/roles\|resources\|grants` | — | Grants admin CRUD. |

> **Hashing library:** `bcryptjs` (pure JS), not `bcrypt`. Every service image is plain
> `node:22-alpine` with no `python3/make/g++`, so a native `bcrypt` build would fail at
> image-build time. `bcryptjs` is API-compatible and needs no toolchain.

Identity is reachable only via the gateway in the prod profile; `/internal/*` is
additionally never proxied (the gateway refuses to route it — it is a server-to-server
route the gateway itself calls).

## C. Authorization (decided: full grants model, enforced at the edge)

- The JWT carries `role` (name, not id). The gateway holds a **grants snapshot** — the
  `{role: {resource: [actions]}}` map fetched from `GET /internal/grants` at boot and
  refreshed every `GRANTS_TTL_MS` (default 60s).
- A **route→permission table** in the gateway names the required `(resource, action)`
  per protected route, e.g. `POST /products → (catalog.product, create)`,
  `PATCH /products/:id → (catalog.product, update)`,
  `POST /admin/payments/:orderId/refund → (payment.refund, create)`. Unlisted routes need
  authentication only; `/auth/*` and `/webhooks/payment` need neither.
- **Ownership** checks stay in the owning service — the gateway does role/permission, not
  row-level ownership. **Order does not currently have them and this phase must add them:**
  `GET /orders/:id` (`services/order/src/app.ts:173`) and `GET /orders/:id/stream` look an
  order up by id with no `userId` filter and return the owner's id in the body. That is
  invisible today (there is no identity) but becomes an IDOR the moment callers are
  authenticated — any logged-in user could read and live-stream anyone's order. Both routes
  gain an ownership check scoped to the injected `x-user-id`, answering **404** (not 403) so
  order ids stay unenumerable. Cart routes already scope correctly.
- Boot behavior: if the snapshot cannot be fetched at boot, the gateway **fails fast**
  (exits) rather than serving with an empty matrix that would 403 everything or, worse,
  allow everything. Refresh failures mid-life keep the last good snapshot and log.
- **Accepted trade-off:** a grant edit takes up to one TTL to take effect. The
  alternative — a synchronous authz call per request — puts identity on the hot path of
  every proxied request, which the breaker would then have to protect.
- Seeding: a committed seed (`prisma/seed.ts`, run explicitly) creates roles `USER` /
  `ADMIN`, the resources above, and the admin grants. Without it no one can administer
  anything.

## D. Identity propagation (decided: gateway injects a trusted header)

- The gateway **strips** `x-user-id` and `x-user-role` from every inbound request before
  routing — unconditionally, including on unauthenticated routes — then injects the
  verified values for authenticated ones. A client cannot forge identity even by
  guessing header names.
- Services keep reading `x-user-id` (Order's `app.ts` already does), so **the retrofit is
  header hygiene at the edge plus network isolation**, not a rewrite of every service.
  Existing int/e2e tests that set the header keep working unchanged.
- **Network isolation is what makes this safe.** A new `prod` compose profile publishes
  **only** the gateway's port; service `ports:` mappings live in the default `app`
  profile for local development. Documented explicitly as the trust boundary.
- **Rejected:** per-service JWT re-verification (defense in depth, but key distribution
  everywhere plus every test minting real tokens) and a gateway-signed internal
  assertion (a second crypto system to build and rotate). Both are recorded as Phase-7
  options if services ever become directly reachable.

## E. Gateway edge behavior

- **Proxy:** `http-proxy-middleware`, one route group per upstream. Services are mounted at
  their **real** paths — verified against the code, no rewriting:
  `/cart`, `/orders` → order (`services/order/src/app.ts`);
  `/products`, `/comments`, `/discounts` → catalog (`services/catalog/src/app.ts:48-215`,
  which serves `/products`, `/products/:id/comments`, `/comments/:id`, `/discounts` — there
  is no `/catalog` prefix to rewrite to);
  `/admin/payments`, `/webhooks/payment` → payment (`services/payment/src/app.ts:52,71`);
  **not** `GET /payments/:orderId` — see Known limitations;
  `/auth` → identity. `changeOrigin: false`, `xfwd: true`.
- **`POST /webhooks/payment` is proxied but exempt from auth AND CSRF.** It is a provider
  callback with no browser session and no cookie; the prod profile closes payment's port, so
  routing it through the gateway is the only way it stays reachable. It keeps the general
  rate-limit bucket. (Signature verification is a Phase-7 item — the endpoint is
  unauthenticated today.)
- **Timeouts + breaker:** every non-SSE upstream call is wrapped in an `opossum` breaker
  (`timeout` 5s, `errorThresholdPercentage` 50, `resetTimeout` 10s), one breaker
  **per upstream** so a sick catalog cannot open the order circuit. Breaker open → 503,
  timeout → 504.
- **SSE is exempt.** `GET /orders/:id/stream` bypasses the breaker and the timeout — an
  `opossum` timeout would guillotine a *healthy* long-lived stream — and sets
  `Cache-Control: no-cache`, `X-Accel-Buffering: no`, compression off. This is the
  phase's named risk and gets a dedicated streaming test.
- **Refresh translation (the cookie↔body seam):** the browser never sends a refresh token in
  a body. On `POST /auth/refresh` the gateway reads the `refresh_token` **cookie**, calls
  identity with it in the body, and on 200 re-sets both cookies plus a fresh `XSRF-TOKEN`.
  On identity's 401 (unknown / reused / expired) the gateway **clears all three cookies** and
  returns 401, so a reuse-detected client lands back at login instead of retrying a dead
  token. A missing cookie is a 401 without calling identity.
- **Cookies:** on login/refresh the gateway sets `access_token` and `refresh_token` as
  **httpOnly, SameSite=Lax**, `Secure` only when `COOKIE_SECURE=true` (prod profile),
  plus a **readable** `XSRF-TOKEN` cookie.
- **CSRF:** double-submit. Every mutating method (POST/PUT/PATCH/DELETE) outside
  `/auth/login|register|refresh` must echo the `XSRF-TOKEN` value in an `X-CSRF-Token`
  header; mismatch → 403. Safe methods and the SSE stream are exempt.
- **Rate limit:** `express-rate-limit` — a strict bucket on `/auth/*` (10/min/IP, the
  credential-stuffing surface) and a general bucket elsewhere (300/min/IP).
- **helmet** with defaults; **traceId** minted here and forwarded as `x-trace-id`
  (`traceMiddleware` already reads it downstream).
- **`/readyz` means "the grants snapshot is loaded"** — nothing more. Upstream reachability
  is deliberately NOT probed: one sick service must not take the whole edge out of rotation,
  which is exactly what the per-route breaker exists to handle.
- The gateway keeps **no** database and **no** business rules. If a decision needs domain
  data, it belongs in a service.

## F. Events

```ts
export const IDENTITY_USER_REGISTERED = "identity.user_registered" as const;
export const UserRegisteredPayloadSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
});
```

Lives in `packages/contracts/src/events/identity.ts` and **must be added to
`packages/contracts/src/index.ts`**, which exports each event module explicitly. Emitted via
the outbox in the same tx as the `User` insert; relay publishes to `identity.events`
(`aggregateType: "identity"`). **No consumer this phase** (user
decision) — Notification's welcome email is a named backlog item, not silent scope.

> PII note: the payload carries an email because a future welcome-email consumer needs
> a recipient; the project's no-PII-in-logs rule still applies — identity logs `userId`
> and never the email or password.

## G. Wiring / infra

- Compose: `identity` (:3006) and `gateway` (:8000) under the `app` profile with
  `restart: unless-stopped`; gateway `depends_on` the services it proxies. A `prod`
  profile variant publishes only `8000`. `kafka-ui` already owns 8080, hence 8000.
- CI: an Identity step (migrate deploy + `pnpm vitest run services/identity`) and a
  Gateway step (no DB, stub-backed).
- `docs/runbooks/phase-6-auth-demo.md`: keypair generation, seed, register → login →
  cookie → browse/cart/checkout through the gateway only, SSE over the proxy, a rejected
  admin mutation, and the closed-ports check.

## Configuration & inherited Definition of Done

Identity: `DATABASE_URL`, `KAFKA_BROKERS`, `JWT_PRIVATE_KEY`, `ACCESS_TTL` (15m),
`REFRESH_TTL_DAYS` (7), `BCRYPT_COST` (10), `PORT` (3006), `LOG_LEVEL`.
Gateway: `JWT_PUBLIC_KEY`, `IDENTITY_URL`, `ORDER_URL`, `CATALOG_URL`, `PAYMENT_URL`,
`GRANTS_TTL_MS` (60000), `COOKIE_SECURE` (false), `PORT` (8000), `LOG_LEVEL`.

Inherited per-service DoD: health router (`/healthz`, `/readyz`), structured logging with
traceId, graceful shutdown, migrations CLI-only, per-service env gitignored, no secrets or
PII in logs.

## Design decisions (resolved)

| # | Decision | Why |
|---|---|---|
| 1 | Combined 6a+6b, one spec | User choice; avoids a cross-phase seam between issuing tokens and enforcing them. |
| 2 | RS256, gateway verifies with the public key | No shared secret; only identity can mint. JWKS deferred — rotation is Phase 7. |
| 3 | Gateway injects `x-user-id`; services unchanged | Near-zero retrofit, existing tests survive; safe because the prod profile makes services unreachable directly. |
| 4 | Multi-session refresh rows, family-scoped reuse revocation | Legacy's single-row-per-user meant a second login evicted the first — a bug, not a feature. Reuse-detection semantics preserved. |
| 5 | Refresh token opaque + hashed at rest | A DB leak must not yield resumable sessions; a JWT refresh token cannot be revoked. |
| 6 | Full grants model with a gateway-cached snapshot | User choice. Edge enforcement keeps identity off the hot path; TTL staleness is the accepted cost. |
| 7 | `http-proxy-middleware` + `opossum` | Streaming and breaker semantics are exactly the two things that are easy to get subtly wrong by hand, and SSE-through-a-proxy is the phase's named risk. |
| 8 | httpOnly cookies + double-submit CSRF | `EventSource` cannot set an `Authorization` header, so the cookie flow is what makes the proxied SSE stream work at all. |
| 9 | Gateway tested against stub upstreams; real flow via a compose runbook | The platform constraint forbids two services in one Vitest process; stubs keep CI fast and deterministic. |
| 10 | `identity.user_registered` emitted, not consumed | Keeps the phase focused on auth. |

## Known limitations (intentional)

1. **Grant edits are up to `GRANTS_TTL_MS` stale** at the gateway (§C).
2. **No key rotation** — one keypair, no JWKS, no `kid` claim. Phase 7.
3. **Access tokens are not revocable** before their 15m expiry; logout revokes the
   refresh session only. The standard trade-off for stateless verification. **Role changes
   are stale the same way** — a demoted user keeps their old `role` claim until the token
   expires, independently of `GRANTS_TTL_MS`.
4. **No email verification, password reset, or account lockout.** Rate limiting is the
   only brute-force defence.
5. **Services still trust a header** — safe only behind the gateway. Recorded in §D with
   the two hardening options.
6. **No `/metrics`** anywhere (pre-existing platform gap, Phase 7).
7. **A concurrent double-refresh logs the family out.** Rotation claims the row before
   minting (`revokeOne` returns its affected count; 0 = lost race → 401), so two live tokens
   can never coexist in a family. But if the loser's read lands after the winner commits, it
   sees a revoked row and cannot distinguish an honest double-submit from a thief's replay —
   it revokes the family and both clients must log in again. Strict by choice; a grace window
   that tells the two apart is a Phase-7 option.
8. **`GET /payments/:orderId` is not proxied.** `Payment` has no `userId`, so it cannot scope
   by caller; exposing it through the gateway would re-open, for payments, exactly the IDOR
   this phase closed on Order. Phase 7 carries `userId` onto `ChargePayment` and restores the
   route.
9. **The CSRF token is unbound to the session** — textbook stateless double-submit, so an
   attacker who can write cookies (a hostile subdomain, or plain-http MITM) can forge one.
10. **No expiry sweeper for `RefreshToken`** — revoked and expired rows accumulate.

## Testing (TDD)

- **Identity unit:** the rotation/reuse state machine over a fake tx — UNKNOWN, REUSE
  (family revoked), EXPIRED, ROTATED, plus "rotating twice with the same token trips
  reuse". Ported from the legacy behavior, written before the implementation.
- **Identity int (Postgres):** register (dup email → 409, outbox row written in the same
  tx), login (bad credentials indistinguishable), refresh rotation across two sessions
  (device A rotating must not disturb device B), logout scope, grants CRUD.
- **Gateway int (stub upstream):** an in-test http server stands in for the services.
  Covers header stripping (a forged `x-user-id` never reaches the upstream), injection,
  401 vs 403, the CSRF matrix, rate-limit, timeout → 504, breaker open → 503, and an
  **SSE pass-through test that asserts frames arrive incrementally**, not buffered.
- **Order ownership (int):** a second user's `GET /orders/:id` and `/orders/:id/stream` both
  404 while the owner's succeed — the regression test for the IDOR closed in §C.
- **e2e / demo:** `docs/runbooks/phase-6-auth-demo.md` against compose.

## Definition of Done

Register → login → cookie set → browse, cart and checkout through the gateway only;
another user's order returns 404 on both `GET /orders/:id` and its stream;
the order stream is live over the proxied SSE route; an unauthorized admin mutation is
rejected by RBAC; a forged `x-user-id` is stripped; the prod profile exposes only the
gateway port; identity + gateway suites green and the existing service suites unbroken.

## Open questions

None blocking. Deferred by decision: JWKS + key rotation, per-service token verification,
api_keys port, welcome-email consumer, `/metrics`.
