import { createApp } from "./app";
import { config } from "./config";
import { outboxPort } from "./outbox-adapter";
import { handleOrderEvent } from "./consumer";
import { startExpirySweeper } from "./sweeper";
import { prisma } from "./db";
import {
  createKafka,
  createProducer,
  createConsumer,
  startOutboxRelay,
  createLogger,
  gracefulShutdown,
  closeRedis,
} from "@ecom/shared";

const log = createLogger("inventory-main");
const ORDER_TOPIC = "order.events";

async function main() {
  const kafka = createKafka("inventory");
  const producer = createProducer(kafka);
  await producer.connect();

  // Relay drains the outbox; `inventory` aggregate rows go to `inventory.events`.
  const relay = startOutboxRelay(outboxPort, producer, (aggregateType) => `${aggregateType}.events`, {
    intervalMs: 500,
  });

  const consumer = createConsumer(kafka, "inventory-consumers");
  await consumer.connect();
  await consumer.run([ORDER_TOPIC], handleOrderEvent);

  const sweeper = startExpirySweeper(config.SWEEP_INTERVAL_MS);

  const app = createApp();
  const server = app.listen(config.PORT, () => log.info("inventory_listening", { port: config.PORT }));

  // runClosers() tears down in REVERSE of this array, so it is written
  // backwards: backing stores first here (torn down LAST), the HTTP server
  // last here (torn down FIRST — stop accepting traffic, then drain the rest).
  // Each closer awaits its own work so shutdown actually drains before exit.
  // Resulting teardown order:
  //   server.close -> consumer.disconnect -> sweeper.stop -> relay.stop
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
