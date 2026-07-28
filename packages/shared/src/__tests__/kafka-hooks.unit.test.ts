import { describe, it, expect } from "vitest";
import type { Kafka } from "kafkajs";
import { createConsumer } from "../kafka";
import type { KafkaMetricsHooks } from "../metrics";

const END_BATCH = "consumer.end_batch_process";

function fakeKafka() {
  const listeners: Record<string, (e: unknown) => void> = {};
  const consumer = {
    events: { END_BATCH_PROCESS: END_BATCH },
    on: (event: string, cb: (e: unknown) => void) => {
      listeners[event] = cb;
    },
    connect: async () => {},
    disconnect: async () => {},
    subscribe: async () => {},
    run: async () => {},
  };
  const producer = { connect: async () => {}, disconnect: async () => {} };
  const kafka = {
    consumer: () => consumer,
    producer: () => producer,
  } as unknown as Kafka;
  return { kafka, listeners };
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
});
