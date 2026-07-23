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
  gracefulShutdown,
} from "@ecom/shared";

const log = createLogger("order-main");
const INVENTORY_TOPIC = "inventory.events";

async function main() {
  const kafka = createKafka("order");
  const producer = createProducer(kafka);
  await producer.connect();

  // Relay drains the outbox; `order` aggregate rows go to `order.events`.
  const relay = startOutboxRelay(
    outboxPort,
    producer,
    (aggregateType) => `${aggregateType}.events`,
    { intervalMs: 500 }
  );

  // Consume Inventory's reservation result and drive the order state machine.
  const consumer = createConsumer(kafka, "order-consumers");
  await consumer.connect();
  await consumer.run([INVENTORY_TOPIC], handleEvent);

  const app = createApp();
  const server = app.listen(config.PORT, () =>
    log.info("order_listening", { port: config.PORT })
  );

  // runClosers() tears down in REVERSE of this array. Resulting order:
  //   server.close -> consumer.disconnect -> relay.stop -> producer.disconnect
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
  log.error("order_fatal", { message: (e as Error).message });
  process.exit(1);
});
