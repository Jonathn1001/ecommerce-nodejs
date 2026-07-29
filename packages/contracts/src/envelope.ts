import { z } from "zod";
import { v4 as uuidv4 } from "uuid";

export const EventEnvelopeSchema = z.object({
  eventId: z.string().uuid(),
  type: z.string().min(1),
  version: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  traceId: z.string().min(1),
  producer: z.string().min(1),
  // Optional by design: an event minted before Phase 7c carries none, and a required
  // field would retry-then-dead-letter every event in flight during the deploy.
  traceparent: z.string().optional(),
  payload: z.unknown(),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export function makeEnvelope(input: {
  type: string;
  version: number;
  traceId: string;
  producer: string;
  payload: unknown;
  eventId?: string;
  occurredAt?: string;
  traceparent?: string;
}): EventEnvelope {
  return {
    eventId: input.eventId ?? uuidv4(),
    type: input.type,
    version: input.version,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    traceId: input.traceId,
    producer: input.producer,
    ...(input.traceparent ? { traceparent: input.traceparent } : {}),
    payload: input.payload,
  };
}
