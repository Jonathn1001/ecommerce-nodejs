import { Client } from "pg";
import { createLogger } from "@ecom/shared";
import { SubscriberRegistry, type Sink, type StatusFrame } from "./sse-registry";

// Re-exported for existing importers (e.g. app.ts) — the registry itself lives in
// sse-registry.ts, which has no `pg` import, so a unit test can pull it in without
// dragging the Postgres client along transitively.
export { SubscriberRegistry, type Sink, type StatusFrame };

const log = createLogger("order-sse");

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
