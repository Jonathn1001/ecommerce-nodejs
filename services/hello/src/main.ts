// KEPT DELIBERATELY (Phase 7a decision). hello is the platform's canary: the cheapest
// end-to-end proof that DB + outbox + Kafka + health + graceful shutdown still work
// together. It fails before any real service does when a shared package regresses. Do not
// retire it as leftover scaffolding.
import { createApp } from "./app";
import { config } from "./config";
import { outboxPort } from "./outbox-adapter";
import { handleEvent } from "./consumer";
import { prisma } from "./db";
import {
  createKafka,
  createProducer,
  createConsumer,
  startOutboxRelay,
  createLogger,
  createMetrics,
  gracefulShutdown,
  getRedis,
} from "@ecom/shared";

const log = createLogger("hello-main");
const TOPIC = "hello.events";

async function main() {
  const metrics = createMetrics("hello", { defaultMetrics: true });
  const kafka = createKafka("hello");
  const producer = createProducer(kafka);
  await producer.connect();
  const relay = startOutboxRelay(outboxPort, producer, () => TOPIC, { intervalMs: 500 });

  const consumer = createConsumer(kafka, "hello-consumers", metrics.kafkaHooks);
  await consumer.connect();
  await consumer.run([TOPIC], handleEvent);

  const app = createApp({ metrics });
  const server = app.listen(config.PORT, () =>
    log.info("hello_listening", { port: config.PORT })
  );

  // Closers run in REVERSE registration order: stop accepting traffic first,
  // then the relay/consumer/producer, then the backing stores.
  gracefulShutdown([
    async () => void server.close(),
    async () => relay.stop(),
    async () => consumer.disconnect(),
    async () => producer.disconnect(),
    async () => void (await getRedis()).quit(),
    async () => void prisma.$disconnect(),
  ]);
}

main().catch((e) => {
  log.error("hello_fatal", { message: (e as Error).message });
  process.exit(1);
});
