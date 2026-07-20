import { createApp } from "./app";
import { outboxPort } from "./outbox-adapter";
import { handleEvent } from "./consumer";
import { createKafka, createProducer, createConsumer, startOutboxRelay, createLogger } from "@ecom/shared";

const log = createLogger("hello-main");
const TOPIC = "hello.events";

async function main() {
  const kafka = createKafka("hello");
  const producer = createProducer(kafka);
  await producer.connect();
  const relay = startOutboxRelay(outboxPort, producer, () => TOPIC, { intervalMs: 500 });

  const consumer = createConsumer(kafka, "hello-consumers");
  await consumer.connect();
  await consumer.run([TOPIC], handleEvent);

  const app = createApp();
  const server = app.listen(3000, () => log.info("hello_listening", { port: 3000 }));

  const shutdown = async () => {
    relay.stop();
    await consumer.disconnect();
    await producer.disconnect();
    server.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  log.error("hello_fatal", { message: (e as Error).message });
  process.exit(1);
});
