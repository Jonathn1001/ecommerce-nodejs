import { createApp } from "./app";
import { config } from "./config";
import { outboxPort } from "./outbox-adapter";
import { prisma } from "./db";
import {
  createKafka,
  createProducer,
  startOutboxRelay,
  createLogger,
  gracefulShutdown,
} from "@ecom/shared";

const log = createLogger("identity-main");

async function main() {
  const kafka = createKafka("identity");
  const producer = createProducer(kafka);
  await producer.connect();

  // Identity is a producer only: `identity` aggregate rows go to `identity.events`.
  // No commands lane, so no Rabbit connection at all.
  const relay = startOutboxRelay(outboxPort, producer, (t) => `${t}.events`, {
    intervalMs: 500,
  });

  const app = createApp();
  const server = app.listen(config.PORT, () =>
    log.info("identity_listening", { port: config.PORT })
  );

  // Reverse teardown: server.close -> relay.stop -> producer.disconnect -> prisma.
  // The relay stops before its transport closes.
  gracefulShutdown([
    async () => {
      await prisma.$disconnect();
    },
    async () => {
      await producer.disconnect();
    },
    async () => {
      relay.stop();
    },
    async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  ]);
}

main().catch((e) => {
  log.error("identity_fatal", { message: (e as Error).message });
  process.exit(1);
});
