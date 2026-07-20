import { describe, it, expect } from "vitest";
import { drainOutbox, type OutboxRow } from "../outbox";
import { EventEnvelopeSchema } from "@ecom/contracts";

function fakeRow(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    aggregateType: "hello",
    aggregateId: "h1",
    type: "hello.created",
    version: 1,
    traceId: "t1",
    producer: "hello",
    payload: { helloId: "h1", name: "ada" },
    occurredAt: new Date("2026-07-18T00:00:00.000Z"),
    sentAt: null,
    ...over,
  };
}

describe("drainOutbox", () => {
  it("publishes unsent rows as valid envelopes and marks them sent", async () => {
    const rows = [fakeRow()];
    const published: Array<{ topic: string; eventId: string }> = [];
    const marked: string[] = [];

    const count = await drainOutbox(
      {
        fetchUnsent: async () => rows,
        markSent: async (id) => {
          marked.push(id);
        },
      },
      {
        publish: async (topic, env) => {
          expect(() => EventEnvelopeSchema.parse(env)).not.toThrow();
          published.push({ topic, eventId: env.eventId });
        },
      },
      (aggregateType) => `${aggregateType}.events`
    );

    expect(count).toBe(1);
    expect(published[0].topic).toBe("hello.events");
    expect(marked).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });
});
