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
