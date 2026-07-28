# Phase 6 · Identity + Gateway Implementation Plan

**Goal:** Stand up `services/identity` (RS256 auth, rotating multi-session refresh tokens with
reuse-detection, full grants model) and `services/gateway` (proxy, cookies, CSRF, RBAC,
breaker, SSE pass-through), then retrofit identity propagation — including closing the latent
IDOR on Order's read routes.

**Reference spec:** `docs/superpowers/specs/2026-07-25-phase-6-identity-gateway-design.md`

**Tech:** TypeScript, Express, Prisma (Postgres), `jsonwebtoken`, `bcryptjs`,
`http-proxy-middleware`, `opossum`, `express-rate-limit`, `helmet`, `cookie-parser`,
Vitest + supertest.

## Global constraints

- **bcryptjs, never bcrypt** (alpine images have no build toolchain).
- **Identity signs, gateway verifies.** `JWT_PRIVATE_KEY` exists only in identity's env.
- **Refresh tokens are opaque + sha256-hashed at rest**; rotation happens in one tx.
- **Gateway holds no DB and no domain rules.**
- Migrations CLI-only. Per-service env gitignored. Logs carry ids, never email/token/password.
- Two services can never share a Vitest process → gateway tests use a stub upstream.

---

### Task 1: Contracts — `identity.user_registered`

- [ ] **RED** `packages/contracts/src/__tests__/identity-events.test.ts`: type string is
      `identity.user_registered`; payload requires `userId` + a valid `email`; rejects `{}`.
- [ ] **GREEN** `packages/contracts/src/events/identity.ts` with `IDENTITY_USER_REGISTERED`
      and `UserRegisteredPayloadSchema`; add the export line to `src/index.ts`.
- [ ] `pnpm vitest run packages/contracts` green → commit.

### Task 2: Identity scaffold + schema + migration

- [ ] Clone the payment scaffold: `package.json` (`@ecom/identity`, + `jsonwebtoken`,
      `bcryptjs`, `@types/*`), `tsconfig.json`, `Dockerfile` (EXPOSE 3006), `src/db.ts`,
      `src/outbox-adapter.ts`.
- [ ] `src/config.ts`: `DATABASE_URL`, `KAFKA_BROKERS`, `JWT_PRIVATE_KEY`, `ACCESS_TTL`
      (default `15m`), `REFRESH_TTL_DAYS` (7), `BCRYPT_COST` (10), `PORT` (3006), `LOG_LEVEL`.
- [ ] `prisma/schema.prisma` per spec §B (User, RefreshToken, Role, Resource, Grant, Outbox,
      ProcessedEvent) → `prisma migrate dev --name identity_init` → `prisma generate`.
- [ ] `scripts/gen-jwt-keypair.sh` (openssl RSA 2048, prints both PEMs).
- [ ] `pnpm --filter @ecom/identity typecheck` → commit.

### Task 3: Session state machine (pure core)

- [ ] **RED** `src/__tests__/sessions.unit.test.ts` over a fake tx: `UNKNOWN` (no row, no
      side effect), `REUSE` (revoked row → **every row in the family revoked**), `EXPIRED`,
      `ROTATED` (old row gets `revokedAt` + `replacedBy`, new row same `familyId`), and
      "rotating twice with the same token trips REUSE".
- [ ] **GREEN** `src/sessions.ts`: `SessionTx` port + `rotateRefresh(tx, tokenHash, now)`
      returning `{ outcome, token? }`. Pure — no prisma, no config import.
- [ ] Commit.

### Task 4: Auth routes (register / login / refresh / logout)

- [ ] **RED** `src/__tests__/auth.int.test.ts` (supertest + real DB): register writes the user
      **and** the outbox row in one tx; duplicate email → 409; short password → 400; login
      returns a token pair and answers 401 identically for unknown-email and bad-password;
      refresh rotates; **device A rotating does not disturb device B**; a replayed refresh
      token → 401 and kills only that family; logout revokes one session.
- [ ] **GREEN** `src/tokens.ts` (sign RS256 access, mint/hash opaque refresh),
      `src/auth.ts` (service functions over tx ports), `src/tx-adapters.ts`, `src/app.ts`
      (health router + `/auth/*` routes; all async routes try/caught per the Phase-4 lesson).
- [ ] Commit.

### Task 5: Grants model + admin CRUD + `/internal/grants`

- [ ] **RED** `src/__tests__/grants.int.test.ts`: role/resource/grant CRUD; duplicate
      `(role,resource,action)` → 409; `GET /internal/grants` returns the nested
      `{role: {resource: [actions]}}` snapshot.
- [ ] **GREEN** `src/grants.ts` + routes on `app.ts`; `prisma/seed.ts` seeding `USER`/`ADMIN`,
      resources `catalog.product`, `payment.refund`, and the ADMIN grants.
- [ ] `src/main.ts`: Kafka producer + outbox relay (`identity.events`) + server + graceful
      shutdown (teardown order per the Phase-5 review: relay stops before its transport).
- [ ] Commit.

### Task 6: Gateway core — verify, strip/inject, proxy, RBAC

- [ ] Scaffold `services/gateway` (no prisma): `package.json`, `tsconfig.json`, `Dockerfile`
      (EXPOSE 8000), `src/config.ts` (`JWT_PUBLIC_KEY`, `IDENTITY_URL`, `ORDER_URL`,
      `CATALOG_URL`, `PAYMENT_URL`, `GRANTS_TTL_MS`, `COOKIE_SECURE`, `PORT`, `LOG_LEVEL`).
- [ ] **RED** `src/__tests__/gateway.int.test.ts` against a stub upstream http server:
      a forged `x-user-id` never reaches the upstream; a valid token injects the verified
      pair; no/invalid token on a protected route → 401; a `USER` hitting
      `POST /products` → 403 while `ADMIN` passes; `/auth/*` and `/webhooks/payment` need
      neither auth nor CSRF.
- [ ] **GREEN** `src/auth-middleware.ts` (verify RS256, always strip inbound identity headers
      first), `src/grants-cache.ts` (boot fetch + TTL refresh, fail-fast at boot, keep last
      good on refresh failure), `src/authz.ts` (route→permission table), `src/proxy.ts`
      (`http-proxy-middleware` at the real service paths from spec §E), `src/app.ts`.
- [ ] Commit.

### Task 7: Gateway edge — cookies, CSRF, limits, breaker, SSE

- [ ] **RED** extend the gateway tests: login sets httpOnly `access_token`/`refresh_token`
      plus a readable `XSRF-TOKEN`; a mutation without the `X-CSRF-Token` header → 403, with
      it → passes; refresh lifts the cookie into the body and **clears all three cookies on a
      401**; an upstream sleeping past the timeout → 504; repeated failures open the breaker
      → 503; **SSE frames arrive incrementally, not buffered**, and the stream is exempt from
      both breaker and timeout.
- [ ] **GREEN** `src/cookies.ts`, `src/csrf.ts`, `src/breaker.ts` (one `opossum` per
      upstream), rate-limit + helmet in `app.ts`, SSE route registered before the breaker-
      wrapped proxy with buffering disabled.
- [ ] `src/main.ts` + graceful shutdown. Commit.

### Task 8: Retrofit, infra, runbook, regression gate

- [ ] **RED** `services/order/src/__tests__/ownership.int.test.ts`: a second user's
      `GET /orders/:id` and `GET /orders/:id/stream` both **404**; the owner's succeed.
- [ ] **GREEN** scope both Order routes by the caller's id (404, not 403).
- [ ] Compose: `identity` (:3006) + `gateway` (:8000) under `app` with
      `restart: unless-stopped`; a `prod` profile publishing only 8000. CI: identity step
      (migrate deploy + tests) and gateway step (no DB).
- [ ] `docs/runbooks/phase-6-auth-demo.md`: keypair, seed, register → login → cookie →
      cart/checkout through the gateway, SSE over the proxy, a rejected admin mutation, the
      forged-header check, and the closed-ports check.
- [ ] Full regression: every service suite with its own `DATABASE_URL`, `pnpm -r typecheck`,
      `pnpm format:check`. Known-acceptable: the 2 pre-existing `sweeper.int` failures.
- [ ] Commit.
