import { markProcessed, createLogger, type Logger } from "@ecom/shared";
import { EventEnvelope } from "@ecom/contracts";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";

const log: Logger = createLogger("hello-consumer");

// Redis markProcessed is the primary fast-path guard. The ProcessedEvent unique
// constraint (eventId @id) is the durable backstop: if the Redis key was evicted
// and the same event redelivers, the insert throws P2002 — we treat that as
// "already processed" and return, instead of letting the exception wedge the
// Kafka consumer in an infinite offset-retry loop.
export async function handleEvent(env: EventEnvelope): Promise<void> {
  const first = await markProcessed(env.eventId);
  if (!first) {
    log.info("event_duplicate_skipped", { eventId: env.eventId });
    return;
  }
  try {
    await prisma.processedEvent.create({ data: { eventId: env.eventId, type: env.type } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      log.info("event_duplicate_db_skipped", { eventId: env.eventId });
      return;
    }
    throw e;
  }
  log.info("event_processed", { eventId: env.eventId, type: env.type, traceId: env.traceId });
}
