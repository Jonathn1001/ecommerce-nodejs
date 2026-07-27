import { describe, it, expect } from "vitest";
import type { Kafka } from "kafkajs";
import { createConsumer } from "../kafka";

// Fakes just enough of the Kafka client surface that createConsumer touches
// (kafka.consumer() and kafka.producer()) to exercise the eachMessage poison-
// message path without a real broker. This is deliberately a unit test, not
// an int test: kafka-dlq.int.test.ts already covers the end-to-end park via a
// live broker; this file isolates the eventId-as-key guard itself.
function fakeKafka() {
  type EachMessageHandler = (payload: {
    topic: string;
    message: { value: Buffer | null };
  }) => Promise<void>;

  let eachMessage: EachMessageHandler = async () => {};
  const sent: Array<{ topic: string; messages: Array<{ key: unknown; value: string }> }> =
    [];

  const fakeConsumer = {
    connect: async () => {},
    disconnect: async () => {},
    subscribe: async () => {},
    run: async (opts: { eachMessage: EachMessageHandler }) => {
      eachMessage = opts.eachMessage;
    },
  };

  const fakeParker = {
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
    consumer: () => fakeConsumer,
    producer: () => fakeParker,
  } as unknown as Kafka;

  return {
    kafka,
    sent,
    deliver: (raw: string) =>
      eachMessage({ topic: "t", message: { value: Buffer.from(raw) } }),
  };
}

describe("createConsumer DLQ key guard", () => {
  it("parks a message with a non-string eventId using a null key, not the raw value", async () => {
    const f = fakeKafka();
    const consumer = createConsumer(f.kafka, "g-test");
    await consumer.connect();
    await consumer.run(
      ["t"],
      async () => {
        throw new Error("poison");
      },
      { maxRetries: 0 }
    );

    const raw = JSON.stringify({ eventId: 12345, type: "x" }); // eventId is a number, not a string
    await f.deliver(raw);

    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].topic).toBe("t.dlq");
    expect(f.sent[0].messages[0].key).toBeNull();
    expect(f.sent[0].messages[0].value).toBe(raw);
  });

  it("parks a message with an object eventId using a null key", async () => {
    const f = fakeKafka();
    const consumer = createConsumer(f.kafka, "g-test");
    await consumer.connect();
    await consumer.run(
      ["t"],
      async () => {
        throw new Error("poison");
      },
      { maxRetries: 0 }
    );

    const raw = JSON.stringify({ eventId: { nested: true }, type: "x" });
    await f.deliver(raw);

    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].messages[0].key).toBeNull();
  });

  it("still keys on eventId when it is a real string (no regression)", async () => {
    const f = fakeKafka();
    const consumer = createConsumer(f.kafka, "g-test");
    await consumer.connect();
    await consumer.run(
      ["t"],
      async () => {
        throw new Error("poison");
      },
      { maxRetries: 0 }
    );

    const raw = JSON.stringify({ eventId: "abc-123", type: "x" });
    await f.deliver(raw);

    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].messages[0].key).toBe("abc-123");
  });
});
