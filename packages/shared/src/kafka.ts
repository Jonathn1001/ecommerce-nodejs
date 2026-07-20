import { Kafka, logLevel, type Producer, type Consumer } from "kafkajs";
import { EventEnvelopeSchema, type EventEnvelope } from "@ecom/contracts";
import { withRetry } from "./retry";
import { createLogger } from "./logger";

const log = createLogger("kafka");

export function createKafka(clientId: string): Kafka {
  return new Kafka({
    clientId,
    brokers: (process.env.KAFKA_BROKERS ?? "localhost:9092").split(","),
    logLevel: logLevel.NOTHING,
    retry: { retries: 8, initialRetryTime: 300 },
  });
}

export function createProducer(kafka: Kafka) {
  const producer: Producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
  return {
    connect: () => withRetry(() => producer.connect(), { label: "producer.connect" }),
    disconnect: () => producer.disconnect(),
    publish: (topic: string, envelope: EventEnvelope) =>
      producer.send({
        topic,
        messages: [{ key: envelope.eventId, value: JSON.stringify(envelope) }],
      }),
  };
}

export function createConsumer(kafka: Kafka, groupId: string) {
  const consumer: Consumer = kafka.consumer({ groupId });
  const parker: Producer = kafka.producer();
  return {
    connect: async () => {
      await withRetry(() => consumer.connect(), { label: "consumer.connect" });
      await withRetry(() => parker.connect(), { label: "parker.connect" });
    },
    disconnect: async () => {
      await consumer.disconnect();
      await parker.disconnect();
    },
    run: async (
      topics: string[],
      handler: (env: EventEnvelope) => Promise<void>,
      opts: { maxRetries?: number } = {}
    ) => {
      const { maxRetries = 3 } = opts;
      await Promise.all(
        topics.map((t) => consumer.subscribe({ topic: t, fromBeginning: true }))
      );
      await consumer.run({
        eachMessage: async ({ topic, message }) => {
          if (!message.value) return;
          const raw = message.value.toString();
          const env = EventEnvelopeSchema.parse(JSON.parse(raw));
          try {
            await withRetry(() => handler(env), { retries: maxRetries, baseMs: 200 });
          } catch (e) {
            // Poison message: park it and commit so the partition keeps moving.
            log.error("event_parked_to_dlq", {
              eventId: env.eventId,
              topic,
              message: (e as Error).message,
            });
            await parker.send({
              topic: `${topic}.dlq`,
              messages: [{ key: env.eventId, value: raw }],
            });
          }
        },
      });
    },
  };
}
