import { Kafka, logLevel, type Producer, type Consumer } from "kafkajs";
import { EventEnvelopeSchema, type EventEnvelope } from "@ecom/contracts";
import { withRetry } from "./retry";
import { createLogger } from "./logger";
import type { KafkaMetricsHooks } from "./metrics";

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

export function createConsumer(kafka: Kafka, groupId: string, hooks?: KafkaMetricsHooks) {
  const consumer: Consumer = kafka.consumer({ groupId });
  const parker: Producer = kafka.producer();

  if (hooks) {
    // kafkajs hands us offsetLag per topic/partition at the end of every batch. Wrapped
    // because an exception raised inside an instrumentation listener would kill the consumer.
    consumer.on(consumer.events.END_BATCH_PROCESS, (e) => {
      try {
        hooks.onBatch({
          group: groupId,
          topic: e.payload.topic,
          partition: String(e.payload.partition),
          lag: Number(e.payload.offsetLag ?? 0),
        });
      } catch {
        /* never let a metric break consumption */
      }
    });
  }

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
          try {
            const env = EventEnvelopeSchema.parse(JSON.parse(raw));
            const started = process.hrtime.bigint();
            await withRetry(() => handler(env), { retries: maxRetries, baseMs: 200 });
            hooks?.observeHandler({
              group: groupId,
              topic,
              type: env.type,
              seconds: Number(process.hrtime.bigint() - started) / 1e9,
            });
            hooks?.onMessage({ group: groupId, topic, result: "ok" });
          } catch (e) {
            hooks?.onMessage({ group: groupId, topic, result: "dlq" });
            // Poison message: park and commit so the partition keeps moving. Keep the key
            // when the envelope parsed — a DLQ message with no key cannot be traced back.
            // `eventId` must actually be checked to be a string before use as a Kafka
            // message key: a JSON-parseable envelope whose `eventId` is a number or object
            // would otherwise pass an unchecked cast straight to `parker.send`, which
            // throws on a non-string/Buffer/null key — wedging the very partition this
            // DLQ path exists to unblock.
            let eventId: string | null = null;
            try {
              const parsed = JSON.parse(raw) as { eventId?: unknown };
              if (typeof parsed.eventId === "string") eventId = parsed.eventId;
            } catch {
              /* malformed — no id to recover */
            }
            log.error("event_parked_to_dlq", {
              topic,
              eventId,
              message: (e as Error).message,
            });
            await parker.send({
              topic: `${topic}.dlq`,
              messages: [{ key: eventId, value: raw }],
            });
          }
        },
      });
    },
  };
}
