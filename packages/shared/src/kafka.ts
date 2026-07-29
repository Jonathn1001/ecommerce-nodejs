import { Kafka, logLevel, type Producer, type Consumer } from "kafkajs";
import { trace, context, propagation, SpanKind, type Span } from "@opentelemetry/api";
import { EventEnvelopeSchema, type EventEnvelope } from "@ecom/contracts";
import { withRetry } from "./retry";
import { createLogger } from "./logger";
import type { KafkaMetricsHooks } from "./metrics";

const log = createLogger("kafka");
// Resolved lazily (NOT cached at module scope). See outbox.ts's `tracer()` for the
// full repro: under Vitest, this file's ESM `import` of @opentelemetry/api and
// @opentelemetry/sdk-trace-node's internal CJS `require()` of it resolve to two
// separate TraceAPI singletons (verified by object-identity comparison), so a
// ProxyTracer obtained here before a test's NodeTracerProvider.register() runs would
// bind to a side that never receives the delegate. Resolving at span-creation time
// (well after any registration) avoids that. Production is unaffected.
function tracer() {
  return trace.getTracer("@ecom/shared/kafka");
}

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
            // Rebuild a context from the envelope's traceparent (the relay's own span,
            // stamped in Task 6's outbox.ts — not the original business span). Never
            // throws: a malformed value from an older or untrusted producer yields the
            // active context, which starts a fresh trace rather than rejecting the message.
            const parent = (() => {
              try {
                return env.traceparent
                  ? propagation.extract(context.active(), {
                      traceparent: env.traceparent,
                    })
                  : context.active();
              } catch {
                return context.active();
              }
            })();
            await context.with(parent, async () => {
              // Global Constraint 1: span creation (and the attribute calls right
              // after it) is wrapped — a throw here must never skip the handler call
              // below. Unwrapped, it would propagate out of this context.with(),
              // land in the outer try's catch, and park a message whose handler was
              // never even invoked: exactly what Global Constraint 2 forbids.
              let span: Span | undefined;
              try {
                span = tracer().startSpan(`${topic} process`, {
                  kind: SpanKind.CONSUMER,
                });
                // IDs only — never the payload (Global Constraint 9).
                span.setAttribute("messaging.message.id", env.eventId);
                span.setAttribute("messaging.destination.name", topic);
              } catch {
                span = undefined;
              }
              try {
                const runHandler = () =>
                  withRetry(() => handler(env), { retries: maxRetries, baseMs: 200 });
                // The handler must run with `span` — not `parent` — active, so any
                // spans it creates (Prisma, outbox writes) parent to THIS consumer
                // span rather than to the upstream relay's producer span. When span
                // creation above failed, `span` is undefined and the handler runs
                // directly, unchanged.
                await (span
                  ? context.with(trace.setSpan(context.active(), span), runHandler)
                  : runHandler());
              } finally {
                try {
                  span?.end();
                } catch {
                  /* span teardown must never affect message handling */
                }
              }
            });
            // Recording is wrapped SEPARATELY from the handler's try. Unwrapped, a throwing
            // hook would fall into the DLQ catch below and park a message whose handler
            // already succeeded.
            try {
              hooks?.observeHandler({
                group: groupId,
                topic,
                type: env.type,
                seconds: Number(process.hrtime.bigint() - started) / 1e9,
              });
              hooks?.onMessage({ group: groupId, topic, result: "ok" });
            } catch {
              /* never let a metric change message handling */
            }
          } catch (e) {
            try {
              hooks?.onMessage({ group: groupId, topic, result: "dlq" });
            } catch {
              /* never let a metric displace the DLQ park below */
            }
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
