import { createApp } from "./app";
import { config } from "./config";
import { outboxPort } from "./outbox-adapter";
import { ledgerPrunerPort } from "./prune-adapter";
import { handleEvent, setSagaMetrics } from "./consumer";
import { createSagaMetrics } from "./metrics";
import { handleCatalogEvent } from "./catalog-projection";
import { createOrderListener } from "./sse-listener";
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
import { CHARGE_PAYMENT } from "@ecom/contracts";

const log = createLogger("order-main");
const CHARGE_QUEUE = "payment.charge";

async function main() {
  const metrics = createMetrics("order", { defaultMetrics: true });
  setSagaMetrics(createSagaMetrics(metrics.registry));
  const kafka = createKafka("order");
  const producer = createProducer(kafka);
  await producer.connect();

  const rabbit = await createRabbit();
  await rabbit.assertWorkQueue(CHARGE_QUEUE); // producer-side, idempotent (Order may boot before Payment)

  const listener = createOrderListener(config.DATABASE_URL);
  await listener.start();

  // Relay drains the outbox; ChargePayment rows go to RabbitMQ, order.* to Kafka.
  const relay = startOutboxRelay(outboxPort, producer, (t) => `${t}.events`, {
    intervalMs: 500,
    commands: {
      sender: rabbit,
      queueFor: (row) => (row.type === CHARGE_PAYMENT ? CHARGE_QUEUE : null),
    },
  });

  // Consume BOTH the inventory result and the payment result.
  const consumer = createConsumer(kafka, "order-consumers", metrics.kafkaHooks);
  await consumer.connect();
  await consumer.run(["inventory.events", "payment.events"], handleEvent);

  // Separate consumer group for the catalog read-model projection — its own
  // offsets, independent of the saga consumer above.
  const catalogConsumer = createConsumer(
    kafka,
    "order-catalog-projection",
    metrics.kafkaHooks
  );
  await catalogConsumer.connect();
  await catalogConsumer.run(["catalog.events"], handleCatalogEvent);

  const pruner = startLedgerPruner(ledgerPrunerPort, {
    retentionDays: config.LEDGER_RETENTION_DAYS,
    intervalMs: config.LEDGER_PRUNE_INTERVAL_MS,
  });

  const app = createApp({ sseRegistry: listener.registry, metrics });
  const server = app.listen(config.PORT, () =>
    log.info("order_listening", { port: config.PORT })
  );

  // Reverse teardown. Effective order:
  //   server.close -> consumer.disconnect -> catalogConsumer.disconnect -> pruner.stop
  //   -> relay.stop -> rabbit.close -> producer.disconnect -> listener.close
  //   -> prisma.$disconnect
  // The relay must stop before its Rabbit send channel closes.
  gracefulShutdown([
    async () => {
      await prisma.$disconnect();
    },
    async () => {
      await listener.close();
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
    async () => {
      await catalogConsumer.disconnect();
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
  log.error("order_fatal", { message: (e as Error).message });
  process.exit(1);
});
