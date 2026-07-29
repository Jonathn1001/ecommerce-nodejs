import { describe, it, expect, beforeEach } from "vitest";
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { makeEnvelope } from "@ecom/contracts";
import { consumerContextFor } from "../rabbitmq";

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
    const { trace, context } = require("@opentelemetry/api");
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
