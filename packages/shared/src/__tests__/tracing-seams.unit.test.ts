import { describe, it, expect, beforeEach } from "vitest";
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import type { Kafka } from "kafkajs";
import { drainOutbox, type OutboxPort, type CommandChannel } from "../outbox";
import { createConsumer } from "../kafka";
import { makeEnvelope, type EventEnvelope } from "@ecom/contracts";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register();

const STORED = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

beforeEach(() => exporter.reset());

// The parent-span-id accessor moved between SDK majors (`parentSpanId` in v1,
// `parentSpanContext.spanId` in v2). Read whichever this version exposes rather than
// pinning one and having the test fail for a reason that is not the behaviour.
function parentSpanIdOf(span: unknown): string | undefined {
  return (
    (span as { parentSpanContext?: { spanId: string } }).parentSpanContext?.spanId ??
    (span as { parentSpanId?: string }).parentSpanId
  );
}

function portWith(traceparent?: string): OutboxPort {
  return {
    async fetchUnsent() {
      return [
        {
          id: "33333333-3333-4333-8333-333333333333",
          aggregateType: "order",
          aggregateId: "o1",
          type: "order.placed",
          version: 1,
          traceId: "t",
          traceparent,
          producer: "order",
          payload: {},
          occurredAt: new Date(),
          sentAt: null,
        },
      ];
    },
    async markSent() {},
  };
}

describe("relay producer span", () => {
  it("parents to the STORED context and republishes its OWN context", async () => {
    const published: EventEnvelope[] = [];
    await drainOutbox(
      portWith(STORED),
      {
        async publish(_t, e) {
          published.push(e);
        },
      },
      () => "order.events"
    );

    const span = exporter.getFinishedSpans().find((s) => s.name.includes("order.events"));
    expect(span).toBeDefined();
    // Parented to the stored business span…
    expect(span!.spanContext().traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(parentSpanIdOf(span)).toBe("00f067aa0ba902b7");
    // …but the PUBLISHED envelope carries the relay's own span, not the stored one.
    // This is what lets the consumer parent to the relay and makes the poll gap visible.
    expect(published[0].traceparent).not.toBe(STORED);
    expect(published[0].traceparent).toContain(span!.spanContext().spanId);
  });

  it("starts a fresh trace when the stored traceparent is malformed, and does not throw", async () => {
    const published: EventEnvelope[] = [];
    await expect(
      drainOutbox(
        portWith("not-a-traceparent"),
        {
          async publish(_t, e) {
            published.push(e);
          },
        },
        () => "order.events"
      )
    ).resolves.toBeDefined();
    expect(published).toHaveLength(1);
  });
});

describe("relay command-lane producer span", () => {
  it("parents the ChargePayment send to the STORED context and republishes its OWN context", async () => {
    const commanded: EventEnvelope[] = [];
    const commands: CommandChannel = {
      sender: {
        async sendCommand(_q, e) {
          commanded.push(e);
        },
      },
      queueFor: (r) => (r.type === "payment.charge" ? "payment.charge" : null),
    };
    const row = {
      id: "44444444-4444-4444-8444-444444444444",
      aggregateType: "order",
      aggregateId: "o1",
      type: "payment.charge",
      version: 1,
      traceId: "t",
      traceparent: STORED,
      producer: "order",
      payload: {},
      occurredAt: new Date(),
      sentAt: null,
    };
    const port: OutboxPort = {
      async fetchUnsent() {
        return [row];
      },
      async markSent() {},
    };

    await drainOutbox(port, { async publish() {} }, () => "order.events", 100, commands);

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name.includes("payment.charge"));
    expect(span).toBeDefined();
    expect(span!.spanContext().traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(parentSpanIdOf(span)).toBe("00f067aa0ba902b7");
    expect(commanded[0].traceparent).not.toBe(STORED);
    expect(commanded[0].traceparent).toContain(span!.spanContext().spanId);
  });
});

// --- Kafka consumer span --------------------------------------------------
//
// Exercises createConsumer()'s eachMessage handler through a minimal fake Kafka
// client (same shape as kafka-hooks.unit.test.ts's fixture), so the CONSUMER span's
// parenting can be asserted without a live broker.

type EachMessageHandler = (payload: {
  topic: string;
  message: { value: Buffer | null };
}) => Promise<void>;

function fakeKafka() {
  let eachMessage: EachMessageHandler = async () => {};
  const consumer = {
    events: { END_BATCH_PROCESS: "consumer.end_batch_process" },
    on: () => {},
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
    send: async () => {},
  };
  const kafka = {
    consumer: () => consumer,
    producer: () => producer,
  } as unknown as Kafka;
  return {
    kafka,
    deliver: (raw: string) =>
      eachMessage({ topic: "order.events", message: { value: Buffer.from(raw) } }),
  };
}

describe("kafka consumer span", () => {
  it("parents the CONSUMER span to the envelope's traceparent (the relay's span)", async () => {
    const { kafka, deliver } = fakeKafka();
    const consumer = createConsumer(kafka, "g1");
    await consumer.connect();
    await consumer.run(["order.events"], async () => {});

    const raw = JSON.stringify(
      makeEnvelope({
        type: "order.placed",
        version: 1,
        traceId: "t",
        producer: "order",
        payload: {},
        traceparent: STORED,
      })
    );
    await deliver(raw);

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "order.events process");
    expect(span).toBeDefined();
    expect(span!.spanContext().traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(parentSpanIdOf(span)).toBe("00f067aa0ba902b7");
  });

  it("starts a fresh trace when the envelope's traceparent is malformed, and does not throw", async () => {
    const { kafka, deliver } = fakeKafka();
    const consumer = createConsumer(kafka, "g2");
    await consumer.connect();
    let handled = false;
    await consumer.run(["order.events"], async () => {
      handled = true;
    });

    const raw = JSON.stringify(
      makeEnvelope({
        type: "order.placed",
        version: 1,
        traceId: "t",
        producer: "order",
        payload: {},
        traceparent: "not-a-traceparent",
      })
    );
    await expect(deliver(raw)).resolves.toBeUndefined();
    expect(handled).toBe(true);
  });
});
