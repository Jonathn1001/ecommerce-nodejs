import amqp, { type ConfirmChannel, type ChannelModel, type Channel } from "amqplib";
import { trace, context, propagation, SpanKind, type Span } from "@opentelemetry/api";
import { EventEnvelopeSchema, type EventEnvelope } from "@ecom/contracts";
import { withRetry } from "./retry";
import { createLogger } from "./logger";

const log = createLogger("rabbit");
// Resolved lazily (NOT cached at module scope). See outbox.ts's `tracer()` for the
// full repro: under Vitest, this file's ESM `import` of @opentelemetry/api and
// @opentelemetry/sdk-trace-node's internal CJS `require()` of it resolve to two
// separate TraceAPI singletons, so a ProxyTracer obtained here before a test's
// NodeTracerProvider.register() runs would bind to a side that never receives the
// delegate. Resolving at span-creation time (well after any registration) avoids
// that. Production is unaffected.
function tracer() {
  return trace.getTracer("@ecom/shared/rabbitmq");
}

// Exported for the unit test: the extraction is the part that can silently regress.
// Never throws: a malformed or missing traceparent yields the active context, which
// starts a fresh trace rather than rejecting the message.
export function consumerContextFor(env: EventEnvelope) {
  try {
    return env.traceparent
      ? propagation.extract(context.active(), { traceparent: env.traceparent })
      : context.active();
  } catch {
    return context.active();
  }
}

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
      await context.with(consumerContextFor(env), async () => {
        // Global Constraint 1: span creation (and the attribute calls right after it)
        // is wrapped SEPARATELY from the retry/DLQ try below — a throw here must never
        // skip the handler call. Unwrapped, it would propagate out of this
        // context.with(), land in the retry/DLQ catch, and nack/DLQ a message whose
        // handler was never even invoked: exactly what Global Constraint 2 forbids.
        let span: Span | undefined;
        try {
          span = tracer().startSpan(`${queue} process`, { kind: SpanKind.CONSUMER });
          // IDs only — never the payload (sensitive-logging / tracing hygiene).
          span.setAttribute("messaging.message.id", env.eventId);
          span.setAttribute("messaging.destination.name", queue);
        } catch {
          span = undefined;
        }
        try {
          const runHandler = () =>
            withRetry(() => handler(env), {
              retries: maxRetries,
              baseMs: 200,
              label: `consume:${queue}`,
            });
          // The handler must run with `span` — not the extracted `parent` — active,
          // so any spans it creates parent to THIS consumer span rather than to the
          // upstream relay's producer span. When span creation above failed, `span`
          // is undefined and the handler runs directly, unchanged.
          await (span
            ? context.with(trace.setSpan(context.active(), span), runHandler)
            : runHandler());
          ch.ack(msg);
        } catch {
          ch.nack(msg, false, false); // handler exhausted retries -> DLX/DLQ
        } finally {
          try {
            span?.end();
          } catch {
            /* span teardown must never affect message handling */
          }
        }
      });
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

  // Dedicated NON-confirm channel. checkQueue against a missing queue closes the channel it
  // runs on, and `ch` above carries the relay's command lane — a metric must not be able to
  // kill message sending.
  let pollCh: Channel | null = null;
  async function queueDepth(queue: string): Promise<number> {
    try {
      if (!pollCh) {
        const opened = await conn.createChannel();
        // amqplib emits 'error' on a channel-level close (e.g. checkQueue's 404 for a
        // missing queue) IN ADDITION to rejecting the pending RPC. With zero listeners,
        // Node's EventEmitter throws synchronously inside amqplib's frame-dispatch loop;
        // that throw is caught there and re-emitted as the connection's 'frameError',
        // which amqplib wires straight to onSocketError — tearing down the WHOLE
        // connection (every channel on it, including `ch`) instead of just this one.
        // A listener here is required for "dedicated channel" to actually contain the
        // failure; the catch below already handles the rejection.
        opened.on("error", (e: Error) => {
          // Clearing the handle here, not only in the catch below, is what makes an
          // IDLE death recoverable: a broker-initiated close with no queueDepth call
          // in flight has no pending RPC to reject, so the catch never runs and this
          // would otherwise stay pointing at a dead channel — close() would then throw
          // IllegalOperationError and never reach ch.close()/conn.close().
          // Guarded on identity so a late error from a superseded channel cannot
          // discard its replacement.
          if (pollCh === opened) pollCh = null;
          log.warn("poll_channel_error", { message: e.message });
        });
        pollCh = opened;
      }
      const info = await pollCh.checkQueue(queue);
      return info.messageCount;
    } catch (e) {
      pollCh = null; // the failure closed it; next call reopens
      throw e;
    }
  }

  async function close(): Promise<void> {
    lifecycle.markClosing(); // graceful teardown must not trip the restart handler
    if (pollCh) {
      // Belt-and-braces around the listener above: the channel can still die between
      // the check and this call. Releasing the metrics channel must never be the reason
      // the command lane and the connection are left open.
      try {
        await pollCh.close();
      } catch (e) {
        log.warn("poll_channel_close_failed", { message: (e as Error).message });
      }
      pollCh = null;
    }
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
    queueDepth,
    close,
  };
}
