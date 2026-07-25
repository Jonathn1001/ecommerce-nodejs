import type { OutboxPort } from "@ecom/shared";
import { outboxPort } from "../outbox-adapter";

// Vitest runs test FILES in parallel, and every e2e file that starts a relay drains the same
// Order outbox table. Whichever relay polls first claims a row and marks it sent — including
// rows belonging to another file's order, which it then mis-routes (a ChargePayment row whose
// type matches no queueFor rule is published to Kafka instead). The victim then waits forever
// for a command that was delivered somewhere else.
//
// Scoping the FETCH (not just the routing) makes each file's relay handle only its own
// aggregates, so parallel e2e files stop stealing each other's work.
export function scopedOutboxPort(owns: (aggregateId: string) => boolean): OutboxPort {
  return {
    async fetchUnsent(limit) {
      const rows = await outboxPort.fetchUnsent(limit);
      return rows.filter((r) => owns(r.aggregateId));
    },
    markSent: (id) => outboxPort.markSent(id),
  };
}
