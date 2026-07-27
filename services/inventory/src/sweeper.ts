import { randomUUID } from "crypto";
import { Prisma } from "./generated/prisma";
import { createLogger } from "@ecom/shared";
import { prisma } from "./db";
import { releaseRows, type ReleaseCoreTx } from "./release";

const log = createLogger("inventory-sweeper");

function sweepTx(tx: Prisma.TransactionClient, traceId: string): ReleaseCoreTx {
  return {
    async increment(productId, qty) {
      await tx.inventory.update({
        where: { productId },
        data: { available: { increment: qty } },
      });
    },
    async markReleased(id) {
      const r = await tx.reservation.updateMany({
        where: { id, status: "ACTIVE" },
        data: { status: "RELEASED", releasedAt: new Date() },
      });
      return r.count > 0;
    },
    async enqueue(type, orderId, payload) {
      await tx.outbox.create({
        data: {
          aggregateType: "inventory",
          aggregateId: orderId,
          type,
          traceId,
          producer: "inventory",
          payload: payload as Prisma.InputJsonValue,
        },
      });
    },
  };
}

export async function sweepOnce(): Promise<number> {
  const expired = await prisma.reservation.findMany({
    where: { status: "ACTIVE", expiresAt: { lt: new Date() } },
    select: { id: true, orderId: true, productId: true, quantity: true },
  });
  if (expired.length === 0) return 0;

  const byOrder = new Map<string, typeof expired>();
  for (const r of expired) {
    const list = byOrder.get(r.orderId) ?? [];
    list.push(r);
    byOrder.set(r.orderId, list);
  }

  let count = 0;
  for (const [orderId, rows] of byOrder) {
    const traceId = `sweeper-${randomUUID()}`;
    try {
      await prisma.$transaction((tx) =>
        releaseRows(
          sweepTx(tx, traceId),
          orderId,
          rows.map((r) => ({ id: r.id, productId: r.productId, quantity: r.quantity }))
        )
      );
      count += rows.length;
    } catch (e) {
      // One order's failure must not abandon the batch — same lane isolation the outbox
      // relay tick uses. The reservation stays ACTIVE and is retried next sweep; releasing
      // stock against a missing inventory row would be worse than leaving it held.
      log.error("sweep_order_failed", { orderId, message: (e as Error).message });
    }
  }
  log.info("reservations_swept", { count });
  return count;
}

export function startExpirySweeper(intervalMs: number): { stop: () => void } {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sweepOnce();
    } catch (e) {
      log.error("sweep_failed", { message: (e as Error).message });
    } finally {
      running = false;
    }
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
