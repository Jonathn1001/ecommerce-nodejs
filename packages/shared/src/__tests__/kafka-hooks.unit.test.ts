import { describe, it, expect } from "vitest";
import type { Kafka } from "kafkajs";
import { makeEnvelope } from "@ecom/contracts";
import { createConsumer } from "../kafka";
import type { KafkaMetricsHooks } from "../metrics";

const END_BATCH = "consumer.end_batch_process";

type EachMessageHandler = (payload: {
  topic: string;
  message: { value: Buffer | null };
}) => Promise<void>;

function fakeKafka() {
  const listeners: Record<string, (e: unknown) => void> = {};
  let eachMessage: EachMessageHandler = async () => {};
  const sent: Array<{ topic: string; messages: Array<{ key: unknown; value: string }> }> =
    [];

  const consumer = {
    events: { END_BATCH_PROCESS: END_BATCH },
    on: (event: string, cb: (e: unknown) => void) => {
      listeners[event] = cb;
    },
    connect: async () => {},
    disconnect: async () => {},
    subscribe: async () => {},
    run: async (opts: { eachMessage: EachMessageHandler }) => {
      eachMessage = opts.eachMessage;
    },
  };
  const producer = {
    connect: async () => {},
    disconnect: async () => {},
    send: async (args: {
      topic: string;
      messages: Array<{ key: unknown; value: string }>;
    }) => {
      sent.push(args);
    },
  };
  const kafka = {
    consumer: () => consumer,
    producer: () => producer,
  } as unknown as Kafka;
  return {
    kafka,
    listeners,
    sent,
    deliver: (raw: string) =>
      eachMessage({ topic: "order.events", message: { value: Buffer.from(raw) } }),
  };
}

describe("createConsumer metrics wiring", () => {
  it("registers an END_BATCH_PROCESS listener and maps its payload onto onBatch", () => {
    const { kafka, listeners } = fakeKafka();
    const seen: unknown[] = [];
    const hooks: KafkaMetricsHooks = {
      onBatch: (p) => seen.push(p),
      onMessage: () => {},
      observeHandler: () => {},
    };

    createConsumer(kafka, "order-consumers", hooks);
    expect(listeners[END_BATCH]).toBeTypeOf("function");

    listeners[END_BATCH]({
      payload: { topic: "order.events", partition: 2, offsetLag: "17" },
    });
    expect(seen).toEqual([
      { group: "order-consumers", topic: "order.events", partition: "2", lag: 17 },
    ]);
  });

  it("registers no listener when no hooks are passed", () => {
    const { kafka, listeners } = fakeKafka();
    createConsumer(kafka, "order-consumers");
    expect(listeners[END_BATCH]).toBeUndefined();
  });

  it("does not propagate a throwing hook", () => {
    const { kafka, listeners } = fakeKafka();
    const hooks: KafkaMetricsHooks = {
      onBatch: () => {
        throw new Error("boom");
      },
      onMessage: () => {},
      observeHandler: () => {},
    };

    createConsumer(kafka, "g", hooks);
    expect(() =>
      listeners[END_BATCH]({ payload: { topic: "t", partition: 0, offsetLag: "1" } })
    ).not.toThrow();
  });

  it("does not park a successfully-handled message when a success-path hook throws", async () => {
    const { kafka, sent, deliver } = fakeKafka();
    const hooks: KafkaMetricsHooks = {
      onBatch: () => {},
      onMessage: () => {},
      observeHandler: () => {
        throw new Error("boom");
      },
    };

    const consumer = createConsumer(kafka, "order-consumers", hooks);
    await consumer.connect();
    await consumer.run(["order.events"], async () => {
      /* business handler succeeds */
    });

    const raw = JSON.stringify(
      makeEnvelope({
        type: "order.created",
        version: 1,
        traceId: "trace-1",
        producer: "test",
        payload: {},
      })
    );

    await expect(deliver(raw)).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});
