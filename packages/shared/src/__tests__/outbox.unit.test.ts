import { describe, it, expect } from "vitest";
import { drainOutbox, type OutboxRow, type CommandChannel } from "../outbox";
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

describe("drainOutbox — command channel routing", () => {
  it("routes command rows to the sender and event rows to the Kafka producer", async () => {
    const rows = [
      fakeRow({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        type: "order.confirmed",
        aggregateType: "order",
      }),
      fakeRow({
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        type: "payment.charge",
        aggregateType: "order",
      }),
    ];
    const published: string[] = [];
    const commanded: Array<{ queue: string; eventId: string }> = [];
    const marked: string[] = [];
    const commands: CommandChannel = {
      sender: {
        sendCommand: async (queue, env) => {
          commanded.push({ queue, eventId: env.eventId });
        },
      },
      queueFor: (r) => (r.type === "payment.charge" ? "payment.charge" : null),
    };
    const count = await drainOutbox(
      {
        fetchUnsent: async () => rows,
        markSent: async (id) => {
          marked.push(id);
        },
      },
      {
        publish: async (topic) => {
          published.push(topic);
        },
      },
      (a) => `${a}.events`,
      100,
      commands
    );
    expect(count).toBe(2);
    expect(published).toEqual(["order.events"]);
    expect(commanded).toEqual([
      { queue: "payment.charge", eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    ]);
    expect(marked.sort()).toEqual(
      [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ].sort()
    );
  });

  it("a failing rabbit lane does not stop the kafka lane (allSettled)", async () => {
    const rows = [
      fakeRow({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", type: "order.confirmed" }),
      fakeRow({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", type: "payment.charge" }),
    ];
    const marked: string[] = [];
    const commands: CommandChannel = {
      sender: {
        sendCommand: async () => {
          throw new Error("rabbit down");
        },
      },
      queueFor: (r) => (r.type === "payment.charge" ? "payment.charge" : null),
    };
    await drainOutbox(
      {
        fetchUnsent: async () => rows,
        markSent: async (id) => {
          marked.push(id);
        },
      },
      { publish: async () => {} },
      (a) => `${a}.events`,
      100,
      commands
    );
    // the kafka row still committed; the failed rabbit row stays unsent
    expect(marked).toEqual(["cccccccc-cccc-4ccc-8ccc-cccccccccccc"]);
  });
});
