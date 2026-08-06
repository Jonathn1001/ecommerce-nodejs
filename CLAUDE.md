# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A **pnpm monorepo of TypeScript microservices** (`ecommerce-platform`) — 6 domain services
plus a gateway, Postgres per service, Kafka + RabbitMQ + Redis, React storefront.

`legacy/` is the **read-only reference copy of the old Express/MongoDB MVC monolith**
that this platform replaced (locked decision #8). Do not develop there, do not cite its
scripts (`npm run ci` there is a pm2 restart), and do not let its `README.md` describe
the current system. Everything below concerns the workspace outside `legacy/`.

Requires Node >= 22 and pnpm 10 (pinned via `packageManager`).

## Commands

```bash
pnpm install
pnpm --filter "./services/*" --filter '!@ecom/gateway' exec prisma generate   # after install/clone
```

Prisma clients are **gitignored** and generated into each service's own
`src/generated/prisma`, so nothing typechecks or builds until that command runs.
`@ecom/gateway` matches the filter but has no schema — leaving it in fails the whole
recursive step.

| Task | Command |
|---|---|
| Typecheck all (incl. `infra/`) | `pnpm typecheck` |
| Lint / format | `pnpm lint` · `pnpm format` · `pnpm format:check` |
| Build all | `pnpm build` (`pnpm -r build`) |
| Unit tests only | `pnpm vitest run --exclude "**/*.int.test.ts" --exclude "**/*.e2e.test.ts"` |
| Everything (needs compose infra) | `pnpm test` |
| One workspace's tests | `pnpm vitest run services/order` |
| One file / one case | `pnpm vitest run services/order/src/__tests__/transition.unit.test.ts -t "nextStatus"` |

**Vitest positional args are substring path filters, not globs.** `pnpm vitest run
"**/*.int.test.ts"` matches nothing and exits green. Select by directory substring, or
use `--exclude` for the inverse.

Test tiers by filename: `*.unit.test.ts` / `*.test.ts` pure · `*.int.test.ts` needs a
broker or DB · `*.e2e.test.ts` needs the whole stack up. CI runs the first tier in the
`quality` job and the rest in `integration`, one service at a time with that service's
own `DATABASE_URL`.

Per service (`services/<name>`): `pnpm --filter @ecom/<name> exec prisma migrate deploy`,
`pnpm --filter @ecom/<name> start` (tsx), and `pnpm --filter @ecom/identity seed`.

Storefront: `pnpm --filter @ecom/web dev` · `build` · `e2e` (Playwright, **local only** —
CI has no compose stack; see `docs/infra.md`).

Infra: `cp docker-compose.example.yml docker-compose.yml && cp .env.example .env && docker compose up -d`.
Datastores come up alone; **the eight services sit behind the `app` profile** —
`docker compose --profile app up -d`. Full detail, ports, and the mailpit/drift traps
are in `docs/infra.md`; operational scripts (`assert-invariants`, `chaos.sh`,
`drain-dlq`, `reset-dev-topics`) live in `infra/scripts/` and are driven by
`docs/runbooks/`.

## Architecture

Locked decisions live in `docs/superpowers/specs/2026-07-18-microservices-streaming-rebuild-design.md`.
The load-bearing ones:

- **Database-per-service, no cross-service DB reads.** Each service owns a Postgres
  database and a Prisma schema. Data crosses services only as events.
- **Kafka = domain event log · RabbitMQ = commands/tasks + DLQ · Redis = cache, lock,
  idempotency.** Picking the wrong lane for new work is the most common design error here.
- **REST only at the gateway edge.** Services never call each other synchronously.
- Payment is a real service with a **simulated** gateway (deterministic success/fail by
  amount — `services/payment/src/charge.ts`).

Ports: hello 3000 (a deliberately-kept canary service, not dead code), inventory 3001,
order 3002, payment 3003, catalog 3004, notification 3005, identity 3006, gateway 8000,
web 5173. Grafana is on 3007 because 3000–3006 are taken.

### Shared spine

- `packages/contracts` — Zod event/HTTP schemas plus the **`EventEnvelope`**
  (`eventId`, `type`, `version`, `occurredAt`, `traceId`, `producer`, optional
  `traceparent`, `payload`). Every Kafka/Rabbit message is an envelope. New optional
  fields must stay optional: a required one dead-letters everything in flight during a
  deploy.
- `packages/shared` — one implementation each of logger, config, health, `metrics`,
  `retry`, `lifecycle` (graceful shutdown), `redis`, `kafka`, `rabbitmq`, `outbox`
  relay, `ledger-pruner`. Build here once, adopt per service; do not fork these.

### Patterns to preserve

- **Transactional outbox.** Services write domain rows + an outbox row in one
  transaction; a relay tick publishes them. Consumers dedupe through a
  `ProcessedEvent` ledger (pruned by `startLedgerPruner`) or Redis `markProcessed`.
- **Order is the saga's state machine.** `services/order/src/transition.ts` is a pure
  table: `PENDING →(InventoryReserved) AWAITING_PAYMENT →(PaymentSucceeded) CONFIRMED`,
  with `CANCELLED` from either failure. `setStatus(orderId, status, expected)` is a
  compare-and-set that returns `false` on a lost race — keep writes going through it.
- **Order prices from its own `catalog_read_model`**, fed asynchronously by Catalog over
  Kafka. A checkout that beats the projection legitimately gets a 422; tests must wait
  on the projection rather than retry blindly.
- **Gateway holds no domain data.** `services/gateway/src/authz.ts` `RULES` is an
  explicit permission **allowlist**; a route absent from it needs authentication only,
  and ownership checks stay in the owning service. The proxy does **not** rewrite
  prefixes — patterns are the services' real paths, and every one is case-insensitive
  on purpose.
- **Order streams status over SSE** (`sse-listener.ts` / `sse-registry.ts`, Postgres
  LISTEN). The web tracker's fallback ladder (refresh once, poll after 3 errors, stop on
  terminal) is deliberate and must never run SSE and polling at the same time — parallel
  polling masks a completely dead stream.

### Observability

`/metrics` (prom-client) per service; Prometheus/Grafana/Jaeger in compose. Traces come
from `packages/shared/src/tracing.ts`, which is a **preload module**, loaded via
`NODE_OPTIONS=--import tsx --import file:///repo/packages/shared/src/tracing.ts`. Never
export it from `index.ts` or import it as a library — and never give it a relative
import, which deadlocks tsx's resolution hook. `pnpm dev` has no `NODE_OPTIONS` and
therefore exports no spans; that is expected, not a bug.

## Traps that cost real time

- **Two services can never run in one Vitest process.** Each service's `db.ts` loads its
  own `.env` into the shared `process.env.DATABASE_URL`, so the second one wins. Cross-
  service e2e runs *over the wire* against compose-run services, never in-process. This
  is permanent — do not try to solve it per phase.
- **Service containers carry no volume mounts.** After editing a service, `docker compose
  build <svc> && docker compose up -d --no-deps <svc>` or you are testing the old build.
  A route returning 404 through the gateway with a green integration test is this.
- **`docker-compose.yml` and `.env` are your gitignored local copies** and drift behind
  `docker-compose.example.yml` as phases add services. Re-diff when infra-dependent tests
  go red. Never commit either file.
- pnpm's strict layout does not link transitively — a package used directly must be
  declared directly (`pg` and `zod` both bit `@ecom/web`).

## Repo conventions

- Specs and plans: `docs/superpowers/specs/` and `plans/`. Per-feature working notes,
  impl-notes and merge records: `.scratch/<feature>/`. Operational walkthroughs:
  `docs/runbooks/`.
- Remaining work is the "Backlog absorption map" at the end of
  `docs/superpowers/specs/2026-07-23-phases-3-8-roadmap.md`; phases 0–8 are merged.
- `course-interview/` is published documentation output, not application code.
