import amqp, { type ConfirmChannel, type ChannelModel } from "amqplib";
import { EventEnvelopeSchema, type EventEnvelope } from "@ecom/contracts";
import { withRetry } from "./retry";
import { createLogger } from "./logger";

const log = createLogger("rabbit");

// Connection-liveness state machine, split out so the restart decision is unit-testable
// without a broker. Docker restart policies fire on process EXIT, never on an unhealthy
// healthcheck — so an unexpected close has to end the process for `restart: unless-stopped`
// to mean anything. A close we initiated (graceful shutdown) must not self-kill.
export function makeRabbitLifecycle(onLost: () => void) {
  let healthy = true;
  let closing = false;
  let lost = false;
  return {
    markClosing() {
      closing = true;
    },
    onClose() {
      healthy = false;
      if (closing || lost) return;
      lost = true;
      onLost();
    },
    onError() {
      healthy = false;
    },
    isHealthy: () => healthy,
  };
}

// DEDUP GUIDANCE (Phase 5): default to the Postgres `ProcessedEvent` ledger (same-tx with
// a DB write — as Order/Inventory/Payment/Notification do). Use the Redis `markProcessed`
// helper (./redis.ts) ONLY for stateless / high-volume dedup with no DB write to bind to.
// It is currently unused; prefer the transactional ledger unless you have that specific need.
export async function createRabbit(
  opts: { prefetch?: number; onConnectionLost?: () => void } = {}
) {
  const {
    prefetch = 10,
    // Default is deliberately fatal: no in-process reconnect (Phase 7), so a dropped
    // connection means every consumer on it is deaf and the relay's command lane is
    // dead. Exiting hands recovery to the compose `restart:` policy.
    onConnectionLost = () => {
      log.error("rabbit_connection_lost", { action: "exit_for_restart" });
      process.exit(1);
    },
  } = opts;
  const url = process.env.RABBITMQ_URL ?? "amqp://ecom:ecom@localhost:5672";
  // Boot-retry absorbs the broker-warming race; on exhaustion this throws (fail-fast) —
  // the caller/process exits and the compose `restart:` policy re-boots it. No degraded
  // state, no in-process reconnect (Phase 7). A mid-life drop marks the adapter unhealthy
  // (/readyz fails) AND exits the process via onConnectionLost — a healthcheck alone never
  // restarts a container, only an exit does.
  const conn: ChannelModel = await withRetry(() => amqp.connect(url), {
    retries: 5,
    baseMs: 500,
    label: "rabbit-connect",
  });
  const ch: ConfirmChannel = await conn.createConfirmChannel();
  await ch.prefetch(prefetch); // bounded unacked in-flight on every consumer

  const lifecycle = makeRabbitLifecycle(onConnectionLost);
  conn.on("close", () => lifecycle.onClose());
  conn.on("error", () => lifecycle.onError());

  async function assertWorkQueue(queue: string): Promise<void> {
    const dlx = `${queue}.dlx`;
    const dlq = `${queue}.dlq`;
    await ch.assertExchange(dlx, "fanout", { durable: true });
    await ch.assertQueue(dlq, { durable: true });
    await ch.bindQueue(dlq, dlx, "");
    await ch.assertQueue(queue, { durable: true, deadLetterExchange: dlx });
  }

  async function sendCommand(queue: string, envelope: EventEnvelope): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      ch.sendToQueue(
        queue,
        Buffer.from(JSON.stringify(envelope)),
        { persistent: true },
        (err) => (err ? reject(err) : resolve()) // confirm-channel broker ack
      );
    });
  }

  async function consumeCommands(
    queue: string,
    handler: (env: EventEnvelope) => Promise<void>,
    opts: { maxRetries?: number } = {}
  ): Promise<void> {
    const { maxRetries = 3 } = opts;
    await ch.consume(queue, async (msg) => {
      if (!msg) return;
      let env: EventEnvelope;
      try {
        env = EventEnvelopeSchema.parse(JSON.parse(msg.content.toString()));
      } catch {
        ch.nack(msg, false, false); // malformed envelope -> DLQ; retrying can't help
        return;
      }
      try {
        await withRetry(() => handler(env), {
          retries: maxRetries,
          baseMs: 200,
          label: `consume:${queue}`,
        });
        ch.ack(msg);
      } catch {
        ch.nack(msg, false, false); // handler exhausted retries -> DLX/DLQ
      }
    });
  }

  async function consumeDlqOnce(
    dlq: string,
    timeoutMs: number
  ): Promise<EventEnvelope | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await ch.get(dlq, { noAck: true });
      if (msg) return EventEnvelopeSchema.parse(JSON.parse(msg.content.toString()));
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  }

  // Acked move: the DLQ copy is only released AFTER the broker confirms the re-publish.
  // consumeDlqOnce's noAck get would drop the envelope for good if the send (or the
  // process) died in between, and a dispatcher ledger + unique key means it can never be
  // regenerated. Returns false when the DLQ is empty.
  async function moveDlqOnce(dlq: string, target: string): Promise<boolean> {
    const msg = await ch.get(dlq, { noAck: false });
    if (!msg) return false;
    try {
      const env = EventEnvelopeSchema.parse(JSON.parse(msg.content.toString()));
      await sendCommand(target, env);
      ch.ack(msg);
      return true;
    } catch (e) {
      ch.nack(msg, false, true); // put it back — a re-publish failure must not lose it
      throw e;
    }
  }

  async function checkHealth(): Promise<void> {
    if (!lifecycle.isHealthy()) throw new Error("rabbit connection is down");
  }

  async function close(): Promise<void> {
    lifecycle.markClosing(); // graceful teardown must not trip the restart handler
    await ch.close();
    await conn.close();
  }

  return {
    assertWorkQueue,
    sendCommand,
    consumeCommands,
    consumeDlqOnce,
    moveDlqOnce,
    checkHealth,
    close,
  };
}
