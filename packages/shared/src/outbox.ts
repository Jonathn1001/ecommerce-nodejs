import { makeEnvelope, type EventEnvelope } from "@ecom/contracts";
import { createLogger } from "./logger";

const log = createLogger("outbox");

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
    producer: row.producer,
    payload: row.payload,
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
  const queueOf = (r: OutboxRow) => commands?.queueFor(r) ?? null;
  const kafkaRows = rows.filter((r) => queueOf(r) === null);
  const rabbitRows = rows.filter((r) => queueOf(r) !== null);

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
    lane(kafkaRows, (r) => producer.publish(topicFor(r.aggregateType), toEnvelope(r))),
    lane(rabbitRows, (r) => commands!.sender.sendCommand(queueOf(r)!, toEnvelope(r))),
  ]);
  for (const r of results) {
    if (r.status === "rejected") log.error("outbox_lane_failed", { message: String(r.reason) });
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
