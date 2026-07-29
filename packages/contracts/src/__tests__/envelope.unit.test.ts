import { describe, it, expect } from "vitest";
import { EventEnvelopeSchema, makeEnvelope } from "../envelope";

const W3C = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("envelope traceparent", () => {
  it("carries traceparent through makeEnvelope", () => {
    const env = makeEnvelope({
      type: "order.placed",
      version: 1,
      traceId: "t",
      producer: "test",
      payload: {},
      traceparent: W3C,
    });
    expect(env.traceparent).toBe(W3C);
  });

  // Deploy safety: an event minted before this deploy has no traceparent at all.
  // If this ever becomes required, every in-flight event dead-letters.
  it("parses an envelope with NO traceparent", () => {
    const parsed = EventEnvelopeSchema.parse({
      eventId: "3f1a7c62-9b0e-4f5d-8a21-2c7e6d4b1f90",
      type: "order.placed",
      version: 1,
      occurredAt: new Date().toISOString(),
      traceId: "t",
      producer: "test",
      payload: {},
    });
    expect(parsed.traceparent).toBeUndefined();
  });

  it("omits traceparent when the caller supplies none", () => {
    const env = makeEnvelope({
      type: "order.placed",
      version: 1,
      traceId: "t",
      producer: "test",
      payload: {},
    });
    expect(env.traceparent).toBeUndefined();
  });
});
