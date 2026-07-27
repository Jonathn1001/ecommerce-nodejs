# Phase 6 — manual demo (identity + gateway)

Proves the browser-style flow: register → login → cookie → browse/cart/checkout through the
gateway only, a live SSE stream over the proxy, a rejected admin mutation, a forged identity
header stripped, and — in the `prod` profile — no way to reach a service directly.

Prereq: `cp docker-compose.example.yml docker-compose.yml`, per-service env, images built.

## 0. Keys and seed (once)

```bash
./services/identity/scripts/gen-jwt-keypair.sh     # prints both PEMs
# put JWT_PRIVATE_KEY / JWT_PUBLIC_KEY into the gitignored compose environment file
docker compose --profile app up -d
docker compose exec identity pnpm exec prisma migrate deploy
docker compose exec identity pnpm seed                # roles, resources, ADMIN grants
```

Without the seed nobody can register (no `USER` role) and nobody can administer anything.

## Key rotation (ops note)

The 7a slice added a JWKS (`GET /.well-known/jwks.json`) so the gateway can verify by `kid`
instead of one static key, but **the shipped JWKS cache never refreshes on a miss** — only on
its own `JWKS_TTL_MS` interval (default 10 minutes; `services/gateway/src/jwks-cache.ts`). An
unknown or missing `kid` is 401 immediately (`auth-middleware.ts` just tries the next
candidate, then fails). Two concrete hazards follow, and the same mitigation covers both:

1. **Rotating identity's signing key.** In a JWKS-only gateway config, the new key's tokens
   401 until the gateway's *next scheduled* refresh — up to `JWKS_TTL_MS` of real 401s, not
   "one refresh attempt."
2. **Tokens minted before this deploy.** They predate the `kid` claim entirely, so
   `keyFor(undefined)` returns `null` without ever consulting the JWKS map. An operator who
   flips straight to JWKS-only on deploy day 401s every live access token issued under the
   previous build, for up to `ACCESS_TTL` (15m default).

**Mitigation for both:** keep the gateway's static `JWT_PUBLIC_KEY` configured through the
rotation/deploy window — `resolveKey` in `services/gateway/src/app.ts` falls back to it
whenever the JWKS lookup misses, with no `kid` match required — or restart the gateway
immediately after rotating (boot does a synchronous, fail-fast `refresh()`). Only drop
`JWT_PUBLIC_KEY` once you're certain no token signed under it, and no token missing a `kid`,
can still be live. See
`docs/superpowers/specs/2026-07-25-phase-7a-correctness-hygiene-design.md` §C4 for the design
rationale.

## 1. Register + login

```bash
curl -sX POST localhost:8000/auth/register -H 'content-type: application/json' \
  -d '{"email":"a@example.test","password":"hunter2hunter2","name":"A"}'

curl -sX POST localhost:8000/auth/login -c jar.txt -H 'content-type: application/json' \
  -d '{"email":"a@example.test","password":"hunter2hunter2"}'
grep -E 'access_token|refresh_token|XSRF-TOKEN' jar.txt
```

`access_token` and `refresh_token` are httpOnly; `XSRF-TOKEN` is readable — the client has to
echo it back, which is what makes double-submit CSRF work.

## 2. Shop through the gateway only

```bash
CSRF=$(awk '/XSRF-TOKEN/ {print $7}' jar.txt)
curl -sX POST localhost:8000/cart/items -b jar.txt -H "X-CSRF-Token: $CSRF" \
  -H 'content-type: application/json' -d '{"productId":"<pid>","quantity":1}'
curl -sX POST localhost:8000/orders -b jar.txt -H "X-CSRF-Token: $CSRF"
```

No `x-user-id` anywhere: the gateway verifies the cookie and injects the identity itself.

**Forged header check** — the same call with `-H 'x-user-id: someone-else'` behaves
identically, because the gateway strips client-supplied identity headers before routing.

**CSRF check** — repeat the cart call without `X-CSRF-Token` → **403**.

## 3. SSE over the proxy

```bash
curl -N -b jar.txt localhost:8000/orders/<orderId>/stream
```

Frames arrive as the saga advances. The stream route is exempt from the circuit breaker and
its timeout — an `opossum` timeout would cut a healthy long-lived stream after a few seconds.

## 4. Ownership

Log in as a second user and request the first user's order:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -b jar2.txt localhost:8000/orders/<orderId>
```

**404**, not 403 — a 403 would confirm the id exists and make order ids enumerable. The same
holds for that order's stream.

## 5. RBAC

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8000/products \
  -b jar.txt -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' -d '{}'
```

**403** for a `USER`. Promote the account and retry:

```bash
docker compose exec postgres psql -U ecom -d identity -c \
  "UPDATE \"User\" SET \"roleId\" = (SELECT id FROM \"Role\" WHERE name='ADMIN') WHERE email='a@example.test';"
```

Log in again (the role is a token claim, so the *old* token keeps the old role until it
expires — 15m by default) → the same call now succeeds.

## 6. Resilience

```bash
docker compose stop catalog
curl -s -o /dev/null -w '%{http_code}\n' localhost:8000/products   # 504, then 503 once the breaker opens
docker compose start catalog                                       # recovers after the reset window
```

The breaker is per-upstream: a sick catalog never opens the order circuit.

## 7. Closed ports

Bring the stack up with the prod overlay and only `8000` is published:

```bash
cp docker-compose.prod.example.yml docker-compose.prod.yml
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app up -d
curl -s -o /dev/null -w '%{http_code}\n' localhost:3002/orders/<orderId>   # connection refused
```

That network isolation is what makes the injected-header trust model safe — services accept
`x-user-id` from whoever can reach them, and with the overlay only the gateway can.

```bash
docker compose --profile app down
```
