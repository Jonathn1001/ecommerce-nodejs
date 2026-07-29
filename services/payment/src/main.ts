import { createApp } from "./app";
import { config } from "./config";
import { outboxPort } from "./outbox-adapter";
import { ledgerPrunerPort } from "./prune-adapter";
import { handleChargePayment, setPaymentMetrics } from "./consumer";
import { createPaymentMetrics } from "./metrics";
import { prisma } from "./db";
import {
  createKafka,
  createProducer,
  startOutboxRelay,
  startLedgerPruner,
  createRabbit,
  createLogger,
  createMetrics,
  gracefulShutdown,
} from "@ecom/shared";

const log = createLogger("payment-main");
const CHARGE_QUEUE = "payment.charge";

async function main() {
  const metrics = createMetrics("payment", { defaultMetrics: true });
  setPaymentMetrics(createPaymentMetrics(metrics.registry));
  const kafka = createKafka("payment");
  const producer = createProducer(kafka);
  await producer.connect();

  // Relay drains the outbox; `payment` aggregate rows go to `payment.events`.
  const relay = startOutboxRelay(outboxPort, producer, (t) => `${t}.events`, {
    intervalMs: 500,
  });

  const rabbit = await createRabbit();
  await rabbit.assertWorkQueue(CHARGE_QUEUE);
  await rabbit.consumeCommands(CHARGE_QUEUE, handleChargePayment, { maxRetries: 3 });

  const pruner = startLedgerPruner(ledgerPrunerPort, {
    retentionDays: config.LEDGER_RETENTION_DAYS,
    intervalMs: config.LEDGER_PRUNE_INTERVAL_MS,
  });

  const dlqPoller = metrics.startDlqPoller(rabbit.queueDepth, [`${CHARGE_QUEUE}.dlq`]);

  const app = createApp({ rabbitHealth: rabbit.checkHealth, metrics });
  const server = app.listen(config.PORT, () =>
    log.info("payment_listening", { port: config.PORT })
  );

  // Reverse teardown: server.close -> dlqPoller.stop -> rabbit.close -> pruner.stop
  //   -> relay.stop -> producer.disconnect -> prisma.$disconnect
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
      await rabbit.close();
    },
    // Stops BEFORE rabbit.close() (declared after it — this array tears down in
    // reverse) because the poller's probe borrows rabbit's connection; it must not
    // outlive it.
    async () => {
      dlqPoller.stop();
    },
    async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  ]);
}

main().catch((e) => {
  log.error("payment_fatal", { message: (e as Error).message });
  process.exit(1);
});
