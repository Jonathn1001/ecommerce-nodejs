import { SEND_EMAIL } from "./commands";
import { renderTemplate } from "./templates";

export interface DispatchTx {
  markProcessed(eventId: string, type: string): Promise<boolean>;
  createNotification(n: {
    orderId: string;
    userId: string;
    type: string;
    to: string;
    subject: string;
  }): Promise<string | null>;
  enqueue(type: string, aggregateId: string, payload: unknown): Promise<void>;
}

// Domain core over a tx port (no prisma/config import — keeps it unit-testable and
// out of the env-dependent module graph, as order/transition.ts and payment/charge.ts do).
// Ledger + row + command all commit together: a redelivered event can neither create a
// second row nor enqueue a second email.
export async function applyDispatch(
  tx: DispatchTx,
  p: { eventId: string; type: string; orderId: string; userId: string },
  domain: string
): Promise<"DISPATCHED" | "DUPLICATE" | "NOOP"> {
  const fresh = await tx.markProcessed(p.eventId, p.type);
  if (!fresh) return "DUPLICATE";
  const to = `${p.userId}@${domain}`;
  const { subject } = renderTemplate(p.type, { orderId: p.orderId });
  const notificationId = await tx.createNotification({
    orderId: p.orderId,
    userId: p.userId,
    type: p.type,
    to,
    subject,
  });
  if (notificationId === null) return "NOOP"; // (orderId,type) already exists
  await tx.enqueue(SEND_EMAIL, p.orderId, { notificationId });
  return "DISPATCHED";
}
