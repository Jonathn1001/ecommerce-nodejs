import { describe, it, expect } from "vitest";
import {
  EventEnvelopeSchema,
  makeEnvelope,
  HelloCreatedPayloadSchema,
  HELLO_CREATED,
} from "../index";

describe("EventEnvelope", () => {
  it("makeEnvelope fills eventId and occurredAt", () => {
    const env = makeEnvelope({
      type: HELLO_CREATED,
      version: 1,
      traceId: "trace-1",
      producer: "hello",
      payload: { helloId: "h1", name: "ada" },
    });
    expect(env.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(env.occurredAt).toString()).not.toBe("Invalid Date");
    expect(EventEnvelopeSchema.parse(env)).toEqual(env);
  });

  it("rejects an envelope missing traceId", () => {
    expect(() => EventEnvelopeSchema.parse({ eventId: "x" })).toThrow();
  });

  it("HelloCreatedPayload rejects a missing name", () => {
    expect(() => HelloCreatedPayloadSchema.parse({ helloId: "h1" })).toThrow();
  });
});
