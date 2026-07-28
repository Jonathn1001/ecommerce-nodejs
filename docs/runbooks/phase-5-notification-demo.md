# Phase 5 — manual demo (notification + mailpit + DLQ replay)

Shows the RabbitMQ work-queue leg end to end: an order event becomes a `Notification`
row, the outbox relay routes a `SendEmail` command to the `notifications` queue, and a
prefetch-bounded worker renders + sends it to mailpit. Then it breaks the mail server
on purpose to demo the DLQ and the replay script.

Prereq: `cp docker-compose.example.yml docker-compose.yml`, per-service env, images built
(`docker compose --profile app build`).

1. `docker compose --profile app up -d`
   Infra now includes **mailpit** (SMTP 1025, UI http://localhost:8025) and the
   **notification** service (:3005). Check it is ready: `curl localhost:3005/readyz`.

2. **Happy path.** Place + confirm an order (per the Phase-3b demo). Open the mailpit UI
   at http://localhost:8025 — an "Order &lt;id&gt; confirmed" email addressed to
   `<userId>@example.test`. The row is SENT:

   ```bash
   docker compose exec postgres psql -U ecom -d notification \
     -c 'SELECT "orderId", type, status, "sentAt" FROM "Notification" ORDER BY "createdAt" DESC LIMIT 5;'
   ```

   Placing the same order twice changes nothing: `(orderId, type)` is unique and the
   `ProcessedEvent` ledger commits in the same transaction as the row and the command.

3. **DLQ demo.** `docker compose stop mailpit`. Confirm another order → the worker's send
   fails → after `maxRetries` the command is dead-lettered. The Notification row stays
   PENDING (it only flips on a successful send), and `notifications.dlq` has depth 1 in
   the RabbitMQ UI (http://localhost:15672, ecom/ecom).

4. **Replay.** `docker compose start mailpit`, then:

   ```bash
   docker compose exec notification pnpm exec tsx scripts/replay-dlq.ts
   ```

   (or host-side with `RABBITMQ_URL` set). The script drains `notifications.dlq` back onto
   `notifications`; the worker sends it, the email appears in mailpit, the row flips SENT.
   Re-running the script is safe — an already-SENT row is skipped by the status CAS.

5. **Liveness-restart contract.** `docker compose kill rabbitmq` → each rabbit-dependent
   container logs `rabbit_connection_lost` and **exits** (an unhealthy healthcheck alone
   would not restart anything — only an exit triggers `restart: unless-stopped`). Compose
   re-boots them; while the broker is still down the boot-retry burns ~15s and the process
   exits again, until `docker compose start rabbitmq` lets a boot succeed. Watch it with
   `docker compose ps` / `docker compose logs -f notification`.

6. `docker compose --profile app down`.

## Notes

- **First boot replays history.** The dispatcher's Kafka group starts `fromBeginning`, so a
  demo stack whose broker has been up since an earlier phase will re-emit mails for old
  orders, and any pre-`userId` events (Phase ≤4) fail to parse and land in `order.events.dlq`.
  A fresh `docker compose down -v` gives the clean first-run story.
- **Duplicate email is possible, a lost one is not.** The send happens outside the DB
  transaction, so a crash between send and CAS — or two concurrent deliveries of the same
  command — can send twice. The row is never wedged: it stays PENDING until some send
  succeeds.
