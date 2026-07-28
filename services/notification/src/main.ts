import { createApp } from "./app";
import { config } from "./config";
import { outboxPort } from "./outbox-adapter";
import { ledgerPrunerPort } from "./prune-adapter";
import { handleOrderEvent } from "./consumer";
import { makeHandleSendEmail } from "./worker";
import { createMailer } from "./mailer";
import { prisma } from "./db";
import {
  createKafka,
  createProducer,
  createConsumer,
  startOutboxRelay,
  startLedgerPruner,
  createRabbit,
  createLogger,
  createMetrics,
  gracefulShutdown,
} from "@ecom/shared";
import { SEND_EMAIL } from "./commands";

const log = createLogger("notification-main");
const QUEUE = "notifications";

async function main() {
  const metrics = createMetrics("notification", { defaultMetrics: true });
  const kafka = createKafka("notification");
  const producer = createProducer(kafka);
  await producer.connect();

  const rabbit = await createRabbit({ prefetch: config.RABBIT_PREFETCH });
  await rabbit.assertWorkQueue(QUEUE);

  // Relay: SendEmail rows -> rabbit `notifications` (the only rows this service emits).
  const relay = startOutboxRelay(outboxPort, producer, (t) => `${t}.events`, {
    intervalMs: 500,
    commands: { sender: rabbit, queueFor: (r) => (r.type === SEND_EMAIL ? QUEUE : null) },
  });

  // Dispatcher: consume order.events -> Notification row + SendEmail command.
  const consumer = createConsumer(kafka, "notification-dispatcher", metrics.kafkaHooks);
  await consumer.connect();
  await consumer.run(["order.events"], handleOrderEvent);

  // Worker: consume the notifications queue (prefetch-bounded).
  const mailer = createMailer({ host: config.SMTP_HOST, port: config.SMTP_PORT });
  await rabbit.consumeCommands(QUEUE, makeHandleSendEmail(mailer), { maxRetries: 3 });

  const pruner = startLedgerPruner(ledgerPrunerPort, {
    retentionDays: config.LEDGER_RETENTION_DAYS,
    intervalMs: config.LEDGER_PRUNE_INTERVAL_MS,
  });

  const dlqPoller = metrics.startDlqPoller(rabbit.queueDepth, [`${QUEUE}.dlq`]);

  const app = createApp({ rabbitHealth: rabbit.checkHealth, metrics });
  const server = app.listen(config.PORT, () =>
    log.info("notification_listening", { port: config.PORT })
  );

  // Reverse teardown. Effective order:
  //   server.close -> consumer.disconnect -> dlqPoller.stop -> pruner.stop -> relay.stop
  //   -> rabbit.close -> producer.disconnect -> prisma.$disconnect
  // The relay must stop before its Rabbit send channel closes (this relay has a
  // commands lane — unlike payment's, which is Kafka-only).
  gracefulShutdown([
    async () => {
      await prisma.$disconnect();
    },
    async () => {
      await producer.disconnect();
    },
    async () => {
      await rabbit.close();
    },
    async () => {
      relay.stop();
    },
    async () => {
      pruner.stop();
    },
    // Stops BEFORE rabbit.close() (declared after it — this array tears down in
    // reverse) because the poller's probe borrows rabbit's connection; it must not
    // outlive it.
    async () => {
      dlqPoller.stop();
    },
    async () => {
      await consumer.disconnect();
    },
    async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  ]);
}

main().catch((e) => {
  log.error("notification_fatal", { message: (e as Error).message });
  process.exit(1);
});
