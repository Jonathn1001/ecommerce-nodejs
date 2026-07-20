import { makeEnvelope, type EventEnvelope } from "@ecom/contracts";

export type OutboxRow = {
  id: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  version: number;
  traceId: string;
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

function toEnvelope(row: OutboxRow): EventEnvelope {
  return makeEnvelope({
    eventId: row.id,
    type: row.type,
    version: row.version,
    occurredAt: row.occurredAt.toISOString(),
    traceId: row.traceId,
    producer: row.producer,
    payload: row.payload,
  });
}

export async function drainOutbox(
  port: OutboxPort,
  producer: ProducerPort,
  topicFor: (aggregateType: string) => string,
  limit = 100
): Promise<number> {
  const rows = await port.fetchUnsent(limit);
  for (const row of rows) {
    await producer.publish(topicFor(row.aggregateType), toEnvelope(row));
    await port.markSent(row.id);
  }
  return rows.length;
}

export function startOutboxRelay(
  port: OutboxPort,
  producer: ProducerPort,
  topicFor: (aggregateType: string) => string,
  opts: { intervalMs?: number; limit?: number } = {}
): { stop: () => void } {
  const { intervalMs = 500, limit = 100 } = opts;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await drainOutbox(port, producer, topicFor, limit);
    } finally {
      running = false;
    }
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
