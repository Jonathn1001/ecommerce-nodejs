import { describe, it, expect } from "vitest";
import {
  drainOutbox,
  type OutboxRow,
  type OutboxPort,
  type CommandChannel,
} from "../outbox";
import { EventEnvelopeSchema, type EventEnvelope } from "@ecom/contracts";

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

describe("drainOutbox — traceparent pass-through", () => {
  it("carries the row's traceparent into the relayed envelope", async () => {
    const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const published: EventEnvelope[] = [];
    const port: OutboxPort = {
      async fetchUnsent() {
        return [
          {
            id: "11111111-1111-4111-8111-111111111111",
            aggregateType: "order",
            aggregateId: "o1",
            type: "order.placed",
            version: 1,
            traceId: "t",
            traceparent: TP,
            producer: "order",
            payload: {},
            occurredAt: new Date(),
            sentAt: null,
          },
        ];
      },
      async markSent() {},
    };
    await drainOutbox(
      port,
      {
        async publish(_t, e) {
          published.push(e);
        },
      },
      () => "order.events"
    );
    expect(published[0].traceparent).toBe(TP);
  });

  // Prisma returns `null` (not `undefined`) for a nullable column with no value —
  // that's the real shape of a pre-7c row, so the fake row sets it explicitly
  // rather than omitting the key. This is what makes the test discriminate against
  // an implementation that passes the literal `null` through to the envelope
  // instead of omitting the `traceparent` key: `toBeUndefined()` fails on `null`.
  it("relays a row with no traceparent (pre-7c rows) without throwing", async () => {
    const published: EventEnvelope[] = [];
    const port: OutboxPort = {
      async fetchUnsent() {
        return [
          {
            id: "22222222-2222-4222-8222-222222222222",
            aggregateType: "order",
            aggregateId: "o2",
            type: "order.placed",
            version: 1,
            traceId: "t",
            traceparent: null,
            producer: "order",
            payload: {},
            occurredAt: new Date(),
            sentAt: null,
          },
        ];
      },
      async markSent() {},
    };
    await drainOutbox(
      port,
      {
        async publish(_t, e) {
          published.push(e);
        },
      },
      () => "order.events"
    );
    expect(published[0].traceparent).toBeUndefined();
  });
});
