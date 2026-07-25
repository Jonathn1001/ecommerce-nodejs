import { createRabbit, createLogger } from "@ecom/shared";

const log = createLogger("notification-replay");

// Drains notifications.dlq back onto the work queue. Safe to re-run: the worker's
// status CAS skips a notification that is already SENT.
async function main() {
  const rabbit = await createRabbit();
  let n = 0;
  for (;;) {
    const env = await rabbit.consumeDlqOnce("notifications.dlq", 1000);
    if (!env) break; // dry
    await rabbit.sendCommand("notifications", env);
    n++;
  }
  log.info("dlq_replayed", { count: n });
  await rabbit.close();
}

main().catch((e) => {
  log.error("replay_fatal", { message: (e as Error).message });
  process.exit(1);
});
