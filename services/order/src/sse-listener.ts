import { Client } from "pg";
import { createLogger } from "@ecom/shared";

const log = createLogger("order-sse");

export type StatusFrame = { orderId: string; status: string };
export interface Sink {
  send(frame: StatusFrame): void;
  end(): void;
}

const TERMINAL = new Set(["CONFIRMED", "CANCELLED"]);

// Pure fan-out: orderId -> set of sinks. No I/O, unit-testable.
export class SubscriberRegistry {
  private map = new Map<string, Set<Sink>>();

  subscribe(orderId: string, sink: Sink): () => void {
    let set = this.map.get(orderId);
    if (!set) {
      set = new Set();
      this.map.set(orderId, set);
    }
    set.add(sink);
    return () => this.unsubscribe(orderId, sink);
  }

  unsubscribe(orderId: string, sink: Sink): void {
    const set = this.map.get(orderId);
    if (!set) return;
    set.delete(sink);
    if (set.size === 0) this.map.delete(orderId);
  }

  dispatch(frame: StatusFrame): void {
    const set = this.map.get(frame.orderId);
    if (!set) return;
    const terminal = TERMINAL.has(frame.status);
    for (const sink of [...set]) {
      sink.send(frame);
      if (terminal) {
        sink.end();
        this.unsubscribe(frame.orderId, sink);
      }
    }
  }

  size(orderId: string): number {
    return this.map.get(orderId)?.size ?? 0;
  }
}

// The dedicated LISTEN connection (Prisma can't hold a LISTEN). Fans NOTIFY
// payloads into the registry. Fail-fast on error (liveness-restart; reconnect = P5).
export function createOrderListener(databaseUrl: string) {
  const registry = new SubscriberRegistry();
  const client = new Client({ connectionString: databaseUrl });

  async function start(): Promise<void> {
    await client.connect();
    await client.query("LISTEN order_status");
    client.on("notification", (msg) => {
      if (!msg.payload) return;
      try {
        registry.dispatch(JSON.parse(msg.payload) as StatusFrame);
      } catch (e) {
        log.error("sse_bad_notify", { message: (e as Error).message });
      }
    });
    client.on("error", (e) => {
      log.error("sse_listener_down", { message: (e as Error).message });
      process.exit(1); // container restart re-establishes; clients auto-reconnect
    });
    log.info("sse_listener_started", {});
  }

  async function close(): Promise<void> {
    await client.end().catch(() => {});
  }

  return { registry, start, close };
}
