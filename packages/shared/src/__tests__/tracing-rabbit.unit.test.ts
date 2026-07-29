import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { trace } from "@opentelemetry/api";
import amqp from "amqplib";
import { makeEnvelope } from "@ecom/contracts";
import { consumerContextFor, createRabbit } from "../rabbitmq";

// Mocked so createRabbit() can be exercised without a live broker. Hoisted by
// Vitest above the imports below, so `createRabbit` (imported after this) always
// sees the mocked module.
vi.mock("amqplib", () => ({
  default: { connect: vi.fn() },
}));

const exporter = new InMemorySpanExporter();
new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
}).register();

const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

beforeEach(() => exporter.reset());

describe("rabbit consumer context", () => {
  it("extracts the envelope's traceparent as the parent", () => {
    const env = makeEnvelope({
      type: "payment.charge",
      version: 1,
      traceId: "t",
      producer: "order",
      payload: {},
      traceparent: TP,
    });
    const ctx = consumerContextFor(env);
    expect(trace.getSpanContext(ctx)!.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("returns the active context — not a throw — for a malformed traceparent", () => {
    const env = makeEnvelope({
      type: "payment.charge",
      version: 1,
      traceId: "t",
      producer: "order",
      payload: {},
      traceparent: "garbage",
    });
    expect(() => consumerContextFor(env)).not.toThrow();
  });

  it("returns the active context when there is no traceparent at all", () => {
    const env = makeEnvelope({
      type: "payment.charge",
      version: 1,
      traceId: "t",
      producer: "order",
      payload: {},
    });
    expect(() => consumerContextFor(env)).not.toThrow();
  });
});

// --- Finding 1 regression: the handler must run with the CONSUMER span active ---
//
// Exercises createRabbit()'s consumeCommands() through a minimal fake amqplib
// channel/connection, so the CONSUMER span's parenting can be asserted without a
// live broker. context.with(consumerContextFor(env), ...) only rebuilds the
// extracted upstream context; it never installs the freshly-created `span` as
// active before invoking the handler. A span started INSIDE the handler is the
// only way to observe which context is actually active there — asserting on
// `span` itself (as the tests above do) cannot catch this, because `span` is
// correctly parented to the extracted context regardless of this bug.

// The parent-span-id accessor moved between SDK majors (`parentSpanId` in v1,
// `parentSpanContext.spanId` in v2). Read whichever this version exposes rather
// than pinning one and having the test fail for a reason that is not the behaviour.
function parentSpanIdOf(span: unknown): string | undefined {
  return (
    (span as { parentSpanContext?: { spanId: string } }).parentSpanContext?.spanId ??
    (span as { parentSpanId?: string }).parentSpanId
  );
}

type ConsumeCallback = (msg: { content: Buffer } | null) => unknown;

function fakeChannel() {
  let onMessage: ConsumeCallback | null = null;
  const acked: unknown[] = [];
  const nacked: unknown[] = [];
  return {
    prefetch: async () => {},
    consume: async (_queue: string, cb: ConsumeCallback) => {
      onMessage = cb;
      return { consumerTag: "fake-consumer" };
    },
    ack: (msg: unknown) => acked.push(msg),
    nack: (msg: unknown) => nacked.push(msg),
    acked,
    nacked,
    // Test-only helper: invokes the callback amqplib would call on delivery, and
    // returns its promise so the test can await handler completion.
    deliver: (raw: string) => onMessage!({ content: Buffer.from(raw) }),
  };
}

function fakeConnection(channel: ReturnType<typeof fakeChannel>) {
  return {
    createConfirmChannel: async () => channel,
    on: () => {},
    close: async () => {},
  };
}

describe("rabbit consumer span — Finding 1 (handler must see `span`, not the extracted parent, as active)", () => {
  it("a span started inside the handler parents to the CONSUMER '... process' span, not to the extracted upstream parent", async () => {
    const channel = fakeChannel();
    vi.mocked(amqp.connect).mockResolvedValue(
      fakeConnection(channel) as unknown as Awaited<ReturnType<typeof amqp.connect>>
    );

    const rabbit = await createRabbit();
    let innerSpanId: string | undefined;
    await rabbit.consumeCommands("payment.charge", async () => {
      // Simulates a Prisma/outbox span created by application code inside the handler.
      const inner = trace.getTracer("test-inner").startSpan("inner-work");
      innerSpanId = inner.spanContext().spanId;
      inner.end();
    });

    const env = makeEnvelope({
      type: "payment.charge",
      version: 1,
      traceId: "t",
      producer: "order",
      payload: {},
      traceparent: TP,
    });
    await channel.deliver(JSON.stringify(env));

    const processSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === "payment.charge process");
    const innerSpan = exporter
      .getFinishedSpans()
      .find((s) => s.spanContext().spanId === innerSpanId);
    expect(processSpan).toBeDefined();
    // Pin the exact name shape (Finding 2) — the acceptance evidence quotes this
    // literally, making it a de-facto contract for downstream consumers.
    expect(processSpan!.name).toBe("payment.charge process");
    expect(innerSpan).toBeDefined();
    expect(parentSpanIdOf(innerSpan)).toBe(processSpan!.spanContext().spanId);
    // TP's span id — if this matched instead, the handler ran with the extracted
    // upstream parent active rather than the consumer `span`.
    expect(parentSpanIdOf(innerSpan)).not.toBe("00f067aa0ba902b7");
    // The bug fix must not change delivery outcome: the message still acks normally.
    expect(channel.acked).toHaveLength(1);
    expect(channel.nacked).toHaveLength(0);
  });
});
