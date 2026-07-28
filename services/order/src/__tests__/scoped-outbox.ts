import type { OutboxPort, OutboxRow } from "@ecom/shared";
import { prisma } from "../db";
import { outboxPort } from "../outbox-adapter";

// Vitest runs test FILES in parallel, and every e2e file that starts a relay drains the same
// Order outbox table. Whichever relay polls first claims a row and marks it sent — including
// rows belonging to another file's order, which it then mis-routes (a ChargePayment row whose
// type matches no queueFor rule is published to Kafka instead). The victim then waits forever
// for a command that was delivered somewhere else.
//
// Scoping the FETCH (not just the routing) makes each file's relay handle only its own
// aggregates, so parallel e2e files stop stealing each other's work.
// The scope goes into the QUERY, not a filter after it. fetchUnsent is
// `take: limit ORDER BY occurredAt ASC`, so filtering afterwards would starve a suite once
// enough foreign unsent rows (left by aborted runs) sit at the head of that window.
export function scopedOutboxPort(ownIds: () => string[]): OutboxPort {
  return {
    async fetchUnsent(limit) {
      const aggregateIds = ownIds();
      if (aggregateIds.length === 0) return [];
      const rows = await prisma.outbox.findMany({
        where: { sentAt: null, aggregateId: { in: aggregateIds } },
        orderBy: { occurredAt: "asc" },
        take: limit,
      });
      return rows as unknown as OutboxRow[];
    },
    markSent: (id) => outboxPort.markSent(id),
  };
}
