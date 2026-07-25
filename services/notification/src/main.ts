import { createApp } from "./app";
import { config } from "./config";
import { outboxPort } from "./outbox-adapter";
import { handleOrderEvent } from "./consumer";
import { makeHandleSendEmail } from "./worker";
import { createMailer } from "./mailer";
import { prisma } from "./db";
import {
  createKafka,
  createProducer,
  createConsumer,
  startOutboxRelay,
  createRabbit,
  createLogger,
  gracefulShutdown,
} from "@ecom/shared";
import { SEND_EMAIL } from "./commands";

const log = createLogger("notification-main");
const QUEUE = "notifications";

async function main() {
  const kafka = createKafka("notification");
  const producer = createProducer(kafka);
  await producer.connect();

  const rabbit = await createRabbit({ prefetch: config.RABBIT_PREFETCH });
  await rabbit.assertWorkQueue(QUEUE);

  // Relay: SendEmail rows -> rabbit `notifications` (the only rows this service emits).
  const relay = startOutboxRelay(outboxPort, producer, (t) => `${t}.events`, {
    intervalMs: 500,
    commands: { sender: rabbit, queueFor: (r) => (r.type === SEND_EMAIL ? QUEUE : null) },
  });

  // Dispatcher: consume order.events -> Notification row + SendEmail command.
  const consumer = createConsumer(kafka, "notification-dispatcher");
  await consumer.connect();
  await consumer.run(["order.events"], handleOrderEvent);

  // Worker: consume the notifications queue (prefetch-bounded).
  const mailer = createMailer({ host: config.SMTP_HOST, port: config.SMTP_PORT });
  await rabbit.consumeCommands(QUEUE, makeHandleSendEmail(mailer), { maxRetries: 3 });

  const app = createApp({ rabbitHealth: rabbit.checkHealth });
  const server = app.listen(config.PORT, () =>
    log.info("notification_listening", { port: config.PORT })
  );

  // Reverse teardown. Effective order:
  //   server.close -> consumer.disconnect -> relay.stop -> rabbit.close
  //   -> producer.disconnect -> prisma.$disconnect
  // The relay must stop before its Rabbit send channel closes (this relay has a
  // commands lane — unlike payment's, which is Kafka-only).
  gracefulShutdown([
    async () => {
      await prisma.$disconnect();
    },
    async () => {
      await producer.disconnect();
    },
    async () => {
      await rabbit.close();
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
  log.error("notification_fatal", { message: (e as Error).message });
  process.exit(1);
});
