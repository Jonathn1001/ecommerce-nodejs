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
  getRedis,
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

  // Closers run in REVERSE registration order: stop accepting traffic first,
  // then the consumer/relay/sweeper/producer, then the backing stores.
  gracefulShutdown([
    async () => void server.close(),
    async () => void consumer.disconnect(),
    async () => relay.stop(),
    async () => sweeper.stop(),
    async () => void producer.disconnect(),
    async () => void (await getRedis()).quit(),
    async () => void prisma.$disconnect(),
  ]);
}

main().catch((e) => {
  log.error("inventory_fatal", { message: (e as Error).message });
  process.exit(1);
});
