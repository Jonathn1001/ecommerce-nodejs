import { trace, context, propagation, SpanKind } from "@opentelemetry/api";
import { makeEnvelope, type EventEnvelope } from "@ecom/contracts";
import { createLogger } from "./logger";

const log = createLogger("outbox");
// Resolved lazily (NOT cached at module scope) — trace.getTracer() returns a
// ProxyTracer that permanently binds to whatever provider is registered at the
// moment it's first asked for a span. Caching it in a module-level const risks
// binding it to a no-op provider if this module is imported before a
// TracerProvider registers (exactly what a test file that imports drainOutbox
// before calling `new NodeTracerProvider(...).register()` would trigger).
function tracer() {
  return trace.getTracer("@ecom/shared/outbox");
}

export type OutboxRow = {
  id: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  version: number;
  traceId: string;
  // Nullable: rows written before Phase 7c have none, and Prisma returns null not undefined.
  traceparent?: string | null;
  producer: string;
  payload: unknown;
  occurredAt: Date;
  sentAt: Date | null;
};

export interface OutboxPort {
  fetchUnsent(limit: number): Promise<OutboxRow[]>;
  markSent(id: string): Promise<void>;
}

export interface ProducerPort {
  publish(topic: string, envelope: EventEnvelope): Promise<unknown>;
}

// A second, honestly-named sender port. createRabbit()'s return object satisfies
// it structurally — no adapter. `queueFor` returns the Rabbit queue for a command
// row, or null = "not a command → publish to Kafka via topicFor" (default path).
export interface CommandSenderPort {
  sendCommand(queue: string, envelope: EventEnvelope): Promise<void>;
}
export interface CommandChannel {
  sender: CommandSenderPort;
  queueFor: (row: OutboxRow) => string | null;
}

function toEnvelope(row: OutboxRow): EventEnvelope {
  return makeEnvelope({
    eventId: row.id,
    type: row.type,
    version: row.version,
    occurredAt: row.occurredAt.toISOString(),
    traceId: row.traceId,
    ...(row.traceparent ? { traceparent: row.traceparent } : {}),
    producer: row.producer,
    payload: row.payload,
  });
}

// Rebuild a context from the stored traceparent. Never throws: a malformed value from an
// older or untrusted producer yields the active context, which starts a fresh trace.
function contextFromRow(row: OutboxRow) {
  try {
    return row.traceparent
      ? propagation.extract(context.active(), { traceparent: row.traceparent })
      : context.active();
  } catch {
    return context.active();
  }
}

// Wraps a single relayed send (Kafka publish or Rabbit sendCommand) in a PRODUCER span
// parented to the row's STORED context. The outgoing envelope's traceparent is then
// overwritten with THIS span's own context, so the consumer parents to the relay — not
// to the original business operation — and the polling delay shows up as the gap
// between the business span ending and this one starting. The stored row itself is
// never mutated: a replayed row still re-parents to the original business operation.
async function publishWithSpan<T>(
  row: OutboxRow,
  spanName: string,
  send: (envelope: EventEnvelope) => Promise<T>
): Promise<T> {
  const envelope = toEnvelope(row);
  const parent = contextFromRow(row);
  return context.with(parent, async () => {
    const span = tracer().startSpan(spanName, { kind: SpanKind.PRODUCER });
    try {
      const carrier: Record<string, string> = {};
      propagation.inject(trace.setSpan(context.active(), span), carrier);
      const outgoing = carrier.traceparent
        ? { ...envelope, traceparent: carrier.traceparent }
        : envelope;
      return await send(outgoing);
    } finally {
      span.end();
    }
  });
}

export async function drainOutbox(
  port: OutboxPort,
  producer: ProducerPort,
  topicFor: (aggregateType: string) => string,
  limit = 100,
  commands?: CommandChannel
): Promise<number> {
  const rows = await port.fetchUnsent(limit);
  // One call per row: queueFor was previously invoked twice per row per tick.
  const routed = rows.map((r) => ({ row: r, queue: commands?.queueFor(r) ?? null }));
  const kafkaRows = routed.filter((r) => r.queue === null).map((r) => r.row);
  const rabbitRows = routed.filter((r) => r.queue !== null);
  const queueById = new Map(rabbitRows.map((r) => [r.row.id, r.queue!]));

  let sent = 0;
  // Within a lane, abort on the first failure (preserves occurredAt order per
  // transport); unsent rows keep sentAt:null and retry next tick.
  const lane = async (
    batch: OutboxRow[],
    send: (r: OutboxRow) => Promise<unknown>
  ): Promise<void> => {
    for (const row of batch) {
      await send(row);
      await port.markSent(row.id);
      sent++;
    }
  };
  // Lanes are independent: a Rabbit outage must not wedge the Kafka rows.
  const results = await Promise.allSettled([
    lane(kafkaRows, (r) => {
      const topic = topicFor(r.aggregateType);
      return publishWithSpan(r, `${topic} publish`, (envelope) =>
        producer.publish(topic, envelope)
      );
    }),
    lane(
      rabbitRows.map((r) => r.row),
      (r) => {
        const queue = queueById.get(r.id)!;
        return publishWithSpan(r, `${queue} send`, (envelope) =>
          commands!.sender.sendCommand(queue, envelope)
        );
      }
    ),
  ]);
  for (const r of results) {
    if (r.status === "rejected")
      log.error("outbox_lane_failed", { message: String(r.reason) });
  }
  return sent;
}

export function startOutboxRelay(
  port: OutboxPort,
  producer: ProducerPort,
  topicFor: (aggregateType: string) => string,
  opts: { intervalMs?: number; limit?: number; commands?: CommandChannel } = {}
): { stop: () => void } {
  const { intervalMs = 500, limit = 100, commands } = opts;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await drainOutbox(port, producer, topicFor, limit, commands);
    } catch (e) {
      // The tick previously had NO catch → an unhandled rejection could crash the
      // process. drainOutbox swallows lane failures (allSettled); this catches
      // fetchUnsent / unexpected faults so the tick is total.
      log.error("outbox_tick_failed", { message: (e as Error).message });
    } finally {
      running = false;
    }
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
