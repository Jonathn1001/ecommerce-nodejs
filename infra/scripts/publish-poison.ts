// Publishes one unparseable message to order.events so the consumers' parse path parks it
// to order.events.dlq. Deliberately not an envelope at all — the Phase 3b fix is about a
// message that cannot be parsed, not one that parses and then fails a handler.
import { Kafka } from "kafkajs";

const BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",");
const TOPIC = process.env.POISON_TOPIC ?? "order.events";

async function main() {
  const producer = new Kafka({
    clientId: "poison-publisher",
    brokers: BROKERS,
  }).producer();
  await producer.connect();
  try {
    await producer.send({
      topic: TOPIC,
      messages: [{ key: `poison-${Date.now()}`, value: "not-a-valid-envelope" }],
    });
    console.log(`published one poison message to ${TOPIC}`);
  } finally {
    await producer.disconnect();
  }
}

void main();
