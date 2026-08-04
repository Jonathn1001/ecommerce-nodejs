# Local Infrastructure

The compose file is committed as `docker-compose.example.yml` (no secrets). Your
runnable copy `docker-compose.yml` and your `.env` are gitignored.

## First run

```bash
cp docker-compose.example.yml docker-compose.yml
cp .env.example .env
docker compose up -d
docker compose ps        # wait until all services are healthy
```

Each service also has its own `.env.example` (e.g. `services/hello/.env.example`)
holding its connection strings. Copy it to `.env` in that service's directory
before migrating or running the service:
`cp services/hello/.env.example services/hello/.env`. Each service loads its own
`.env` regardless of the current working directory.

## Endpoints

| Service    | Address                 | Notes                         |
|------------|-------------------------|-------------------------------|
| Postgres   | localhost:5432          | one DB per service (see init) |
| Kafka      | localhost:9092          | KRaft, no ZooKeeper           |
| Kafka-UI   | http://localhost:8080   | topic browser                 |
| RabbitMQ   | localhost:5672          | AMQP                          |
| Rabbit UI  | http://localhost:15672  | user/pass from `.env`         |
| Redis      | localhost:6379          |                               |
| Mailpit    | http://localhost:8025   | SMTP on 1025; see below       |
| Prometheus | http://localhost:9090   | `/targets`; needs `--profile app` |
| Grafana    | http://localhost:3007   | admin / `GRAFANA_PASSWORD` from `.env` |
| Jaeger     | http://localhost:16686  | traces; needs `--profile app` |

Grafana is on **3007**, not its usual 3000 — the services already occupy 3000-3006.
Both are provisioned from disk (`infra/grafana/provisioning`), so the Prometheus
datasource and the "Checkout — RED & saga" dashboard exist on first boot; there is
nothing to import by hand. Prometheus scrapes each service on its **container** port,
and the gateway on `METRICS_PORT` (9464) rather than 8000 — the gateway's `/metrics`
lives on a separate, deliberately unpublished port, so it is reachable from inside the
compose network only.

**Prometheus and Grafana start with plain `docker compose up -d`, but the eight
things they scrape do not.** The services sit behind the `app` profile (see "First
run" above), so an infra-only boot leaves every Prometheus target `down` and every
dashboard panel on "No data" — which looks like a broken dashboard and is not one.
To see data:

```bash
docker compose --profile app up -d
```

Prometheus and Grafana are deliberately **not** in the `app` profile: monitoring the
stack is useful while you are bringing services up one at a time, so they come up with
infra.

Traces are exported to `jaeger:4318` over the compose network; the OTLP ports
(4317/4318) are deliberately unpublished, so nothing on the host can post spans
directly — only the Jaeger UI on 16686 is reachable. A `traceId` from any service's
log line is the search term to paste into the Jaeger UI to pull up that request's
trace.

**Your local `docker-compose.yml` can drift behind `docker-compose.example.yml`.**
It is your own gitignored copy (`cp docker-compose.example.yml docker-compose.yml`
above), made once — it does not update itself when a later phase adds a service to
the example file. Mailpit is the concrete case: if your copy predates the
notification phase, it has no `mailpit` entry at all, so `docker compose up -d`
neither starts it nor ever recycles it, and a wedged mailpit container (e.g. after
`docker compose stop mailpit` during the DLQ-replay demo, see
`docs/runbooks/phase-5-notification-demo.md`) silently stays down until you notice
notification tests turning red and restart it by hand. If a service's tests depend
on infra your local file might be missing, re-diff against
`docker-compose.example.yml` (or just re-copy it, keeping your `.env`).

## Databases

`infra/postgres/init/01-databases.sql` runs once on first volume creation and
creates a database per service. To re-run it, remove the volume:
`docker compose down -v` (destroys all local data).

## Storefront e2e (local only)

Playwright drives three walks against a real stack. CI never runs them: the `quality` job has
no compose stack, and standing up eight services plus two brokers for three browser walks is
its own slice (8c spec §F4).

```bash
docker compose up -d                 # datastores AND the app profile must be healthy
pnpm --filter @ecom/web dev          # or point WEB_URL at the nginx image
pnpm --filter @ecom/web e2e
```

First run only: `pnpm --filter @ecom/web exec playwright install chromium`.

Overridable: `WEB_URL` (default `http://localhost:5173`), `CATALOG_URL` (`:3004`),
`INVENTORY_URL` (`:3001`).

Two things about this suite are deliberate and worth knowing before changing it:

- **It authenticates once**, in a setup project, and every walk reuses that storage state. The
  gateway allows ten `/auth/*` requests a minute per apparent client, and a browser cannot
  rotate `x-forwarded-for` the way `infra/scripts/drive-checkouts.ts` does — a suite that signed
  in per walk spends its budget on authentication and then fails with 429s that read as
  application bugs.
- **Fixtures address Catalog and Inventory directly**, not through the gateway: creating a
  product is an ADMIN mutation and Inventory is not mounted on the gateway at all. The
  compensation walk needs a product priced so the total lands on `…01`, which is what makes the
  simulated gateway decline (`services/payment/src/charge.ts`).

A service image does **not** pick up source changes — the containers carry no volume mounts. After
touching a service, `docker compose build <service> && docker compose up -d --no-deps <service>`
before running the walks, or they will exercise the previous build.
