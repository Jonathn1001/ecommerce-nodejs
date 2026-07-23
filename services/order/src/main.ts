import { createApp } from "./app";
import { config } from "./config";
import { outboxPort } from "./outbox-adapter";
import { handleEvent } from "./consumer";
import { prisma } from "./db";
import {
  createKafka, createProducer, createConsumer, startOutboxRelay,
  createRabbit, createLogger, gracefulShutdown,
} from "@ecom/shared";
import { CHARGE_PAYMENT } from "@ecom/contracts";

const log = createLogger("order-main");
const CHARGE_QUEUE = "payment.charge";

async function main() {
  const kafka = createKafka("order");
  const producer = createProducer(kafka);
  await producer.connect();

  const rabbit = await createRabbit();
  await rabbit.assertWorkQueue(CHARGE_QUEUE); // producer-side, idempotent (Order may boot before Payment)

  // Relay drains the outbox; ChargePayment rows go to RabbitMQ, order.* to Kafka.
  const relay = startOutboxRelay(outboxPort, producer, (t) => `${t}.events`, {
    intervalMs: 500,
    commands: {
      sender: rabbit,
      queueFor: (row) => (row.type === CHARGE_PAYMENT ? CHARGE_QUEUE : null),
    },
  });

  // Consume BOTH the inventory result and the payment result.
  const consumer = createConsumer(kafka, "order-consumers");
  await consumer.connect();
  await consumer.run(["inventory.events", "payment.events"], handleEvent);

  const app = createApp();
  const server = app.listen(config.PORT, () => log.info("order_listening", { port: config.PORT }));

  // Reverse teardown. Effective order:
  //   server.close -> consumer.disconnect -> relay.stop -> rabbit.close
  //   -> producer.disconnect -> prisma.$disconnect
  // The relay must stop before its Rabbit send channel closes.
  gracefulShutdown([
    async () => { await prisma.$disconnect(); },
    async () => { await producer.disconnect(); },
    async () => { await rabbit.close(); },
    async () => { relay.stop(); },
    async () => { await consumer.disconnect(); },
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
