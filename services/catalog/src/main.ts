import { createApp } from "./app";
import { config } from "./config";
import { outboxPort } from "./outbox-adapter";
import { prisma } from "./db";
import { createKafka, createProducer, startOutboxRelay, createLogger, gracefulShutdown } from "@ecom/shared";

const log = createLogger("catalog-main");

async function main() {
  const kafka = createKafka("catalog");
  const producer = createProducer(kafka);
  await producer.connect();
  const relay = startOutboxRelay(outboxPort, producer, () => "catalog.events", { intervalMs: 500 });
  const app = createApp();
  const server = app.listen(config.PORT, () => log.info("catalog_listening", { port: config.PORT }));
  gracefulShutdown([
    async () => { await prisma.$disconnect(); },
    async () => { await producer.disconnect(); },
    async () => { relay.stop(); },
    async () => { await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))); },
  ]);
}
main().catch((e) => { log.error("catalog_fatal", { message: (e as Error).message }); process.exit(1); });
