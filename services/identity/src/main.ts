import { createApp } from "./app";
import { config } from "./config";
import { outboxPort } from "./outbox-adapter";
import { refreshTokenPrunerPort } from "./prune-adapter";
import { prisma } from "./db";
import {
  createKafka,
  createProducer,
  startOutboxRelay,
  startLedgerPruner,
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

  const pruner = startLedgerPruner(refreshTokenPrunerPort, {
    retentionDays: config.LEDGER_RETENTION_DAYS,
    intervalMs: config.LEDGER_PRUNE_INTERVAL_MS,
  });

  const app = createApp();
  const server = app.listen(config.PORT, () =>
    log.info("identity_listening", { port: config.PORT })
  );

  // Reverse teardown: server.close -> pruner.stop -> relay.stop -> producer.disconnect -> prisma.
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
      pruner.stop();
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
