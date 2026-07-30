// Truncates the Kafka DLQ topics by advancing each partition's low watermark to its high
// watermark, so the checker reads them as empty again.
//
// This exists because the poison scenario's expected outcome is a NON-empty DLQ. Left
// parked, those messages fail every later scenario's "invariants clean" assertion, which
// makes the scenarios order-dependent in a way nothing announces — run poison before kafka
// and kafka looks broken. The poison scenario therefore cleans up after asserting, and any
// scenario ordering works.
import { Kafka } from "kafkajs";

const BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",");
const TOPICS = (
  process.env.DLQ_TOPICS ??
  "hello.events.dlq,order.events.dlq,inventory.events.dlq,payment.events.dlq,catalog.events.dlq"
).split(",");

async function main() {
  const admin = new Kafka({ clientId: "dlq-drainer", brokers: BROKERS }).admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    for (const topic of TOPICS) {
      if (!existing.has(topic)) continue;
      const offsets = await admin.fetchTopicOffsets(topic);
      const depth = offsets.reduce((n, p) => n + (Number(p.high) - Number(p.low)), 0);
      if (depth === 0) continue;
      await admin.deleteTopicRecords({
        topic,
        partitions: offsets.map((p) => ({ partition: p.partition, offset: p.high })),
      });
      console.log(`drained ${depth} message(s) from ${topic}`);
    }
  } finally {
    await admin.disconnect();
  }
}

void main();
