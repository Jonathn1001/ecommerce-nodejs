import { createRabbit, createLogger } from "@ecom/shared";

const log = createLogger("notification-replay");

// Drains notifications.dlq back onto the work queue. Safe to re-run: the worker's
// status CAS skips a notification that is already SENT.
async function main() {
  const rabbit = await createRabbit();
  let n = 0;
  // moveDlqOnce acks the DLQ copy only after the broker confirms the re-publish, so a
  // crash mid-replay leaves the message on the DLQ instead of vaporising it (the row could
  // never be re-dispatched: its eventId is in ProcessedEvent and (orderId,type) is unique).
  while (await rabbit.moveDlqOnce("notifications.dlq", "notifications")) n++;
  log.info("dlq_replayed", { count: n });
  await rabbit.close();
}

main().catch((e) => {
  log.error("replay_fatal", { message: (e as Error).message });
  process.exit(1);
});
