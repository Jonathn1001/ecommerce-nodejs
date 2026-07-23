import { createApp } from "./app";
import { config } from "./config";
import { outboxPort } from "./outbox-adapter";
import { handleChargePayment } from "./consumer";
import { prisma } from "./db";
import {
  createKafka,
  createProducer,
  startOutboxRelay,
  createRabbit,
  createLogger,
  gracefulShutdown,
} from "@ecom/shared";

const log = createLogger("payment-main");
const CHARGE_QUEUE = "payment.charge";

async function main() {
  const kafka = createKafka("payment");
  const producer = createProducer(kafka);
  await producer.connect();

  // Relay drains the outbox; `payment` aggregate rows go to `payment.events`.
  const relay = startOutboxRelay(outboxPort, producer, (t) => `${t}.events`, { intervalMs: 500 });

  const rabbit = await createRabbit();
  await rabbit.assertWorkQueue(CHARGE_QUEUE);
  await rabbit.consumeCommands(CHARGE_QUEUE, handleChargePayment, { maxRetries: 3 });

  const app = createApp({ rabbitHealth: rabbit.checkHealth });
  const server = app.listen(config.PORT, () => log.info("payment_listening", { port: config.PORT }));

  // Reverse teardown: server.close -> rabbit.close -> relay.stop -> producer.disconnect
  //   -> prisma.$disconnect
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
      await rabbit.close();
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
