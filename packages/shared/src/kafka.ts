import { Kafka, logLevel, type Producer, type Consumer } from "kafkajs";
import { EventEnvelopeSchema, type EventEnvelope } from "@ecom/contracts";

export function createKafka(clientId: string): Kafka {
  return new Kafka({
    clientId,
    brokers: (process.env.KAFKA_BROKERS ?? "localhost:9092").split(","),
    logLevel: logLevel.NOTHING,
  });
}

export function createProducer(kafka: Kafka) {
  const producer: Producer = kafka.producer();
  return {
    connect: () => producer.connect(),
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
  return {
    connect: () => consumer.connect(),
    disconnect: () => consumer.disconnect(),
    run: async (topics: string[], handler: (env: EventEnvelope) => Promise<void>) => {
      await Promise.all(
        topics.map((t) => consumer.subscribe({ topic: t, fromBeginning: true }))
      );
      await consumer.run({
        eachMessage: async ({ message }) => {
          if (!message.value) return;
          const env = EventEnvelopeSchema.parse(JSON.parse(message.value.toString()));
          await handler(env);
        },
      });
    },
  };
}
