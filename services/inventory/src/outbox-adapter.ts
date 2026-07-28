import type { OutboxPort, OutboxRow } from "@ecom/shared";
import { prisma } from "./db";

export const outboxPort: OutboxPort = {
  async fetchUnsent(limit) {
    const rows = await prisma.outbox.findMany({
      where: { sentAt: null },
      orderBy: { occurredAt: "asc" },
      take: limit,
    });
    return rows as unknown as OutboxRow[];
  },
  async markSent(id) {
    await prisma.outbox.update({ where: { id }, data: { sentAt: new Date() } });
  },
};
