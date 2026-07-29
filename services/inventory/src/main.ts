import { createApp } from "./app";
import { config } from "./config";
import { outboxPort } from "./outbox-adapter";
import { ledgerPrunerPort } from "./prune-adapter";
import { handleOrderEvent, setReservationMetrics } from "./consumer";
import { createReservationMetrics } from "./metrics";
import { startExpirySweeper } from "./sweeper";
import { prisma } from "./db";
import {
  createKafka,
  createProducer,
  createConsumer,
  startOutboxRelay,
  startLedgerPruner,
  createLogger,
  createMetrics,
  gracefulShutdown,
  closeRedis,
} from "@ecom/shared";

const log = createLogger("inventory-main");
const ORDER_TOPIC = "order.events";

async function main() {
  const metrics = createMetrics("inventory", { defaultMetrics: true });
  setReservationMetrics(createReservationMetrics(metrics.registry));
  const kafka = createKafka("inventory");
  const producer = createProducer(kafka);
  await producer.connect();

  // Relay drains the outbox; `inventory` aggregate rows go to `inventory.events`.
  const relay = startOutboxRelay(
    outboxPort,
    producer,
    (aggregateType) => `${aggregateType}.events`,
    {
      intervalMs: 500,
    }
  );

  const consumer = createConsumer(kafka, "inventory-consumers", metrics.kafkaHooks);
  await consumer.connect();
  await consumer.run([ORDER_TOPIC], handleOrderEvent);

  const sweeper = startExpirySweeper(config.SWEEP_INTERVAL_MS);

  const pruner = startLedgerPruner(ledgerPrunerPort, {
    retentionDays: config.LEDGER_RETENTION_DAYS,
    intervalMs: config.LEDGER_PRUNE_INTERVAL_MS,
  });

  const app = createApp({ metrics });
  const server = app.listen(config.PORT, () =>
    log.info("inventory_listening", { port: config.PORT })
  );

  // runClosers() tears down in REVERSE of this array, so it is written
  // backwards: backing stores first here (torn down LAST), the HTTP server
  // last here (torn down FIRST — stop accepting traffic, then drain the rest).
  // Each closer awaits its own work so shutdown actually drains before exit.
  // Resulting teardown order:
  //   server.close -> consumer.disconnect -> pruner.stop -> sweeper.stop -> relay.stop
  //   -> producer.disconnect -> closeRedis -> prisma.$disconnect
  gracefulShutdown([
    async () => {
      await prisma.$disconnect();
    },
    async () => {
      await closeRedis();
    },
    async () => {
      await producer.disconnect();
    },
    async () => {
      relay.stop();
    },
    async () => {
      sweeper.stop();
    },
    async () => {
      pruner.stop();
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
  log.error("inventory_fatal", { message: (e as Error).message });
  process.exit(1);
});
