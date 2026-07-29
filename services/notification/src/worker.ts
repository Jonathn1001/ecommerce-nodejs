import { createLogger, type Logger } from "@ecom/shared";
import { type EventEnvelope } from "@ecom/contracts";
import { prisma } from "./db";
import { renderTemplate } from "./templates";
import { SendEmailPayloadSchema } from "./commands";
import type { Mailer } from "./mailer";
import type { NotificationMetrics } from "./metrics";

const log: Logger = createLogger("notification-worker");

export type SendRow = {
  id: string;
  to: string;
  type: string;
  orderId: string;
  status: string;
};

export interface WorkerPort {
  loadRow(id: string): Promise<SendRow | null>;
  casSent(id: string): Promise<number>; // updateMany where status=PENDING -> SENT; returns count
}

// `record` is optional so every existing call site and test keeps compiling with 3 args.
export async function applySend(
  port: WorkerPort,
  mailer: Mailer,
  notificationId: string,
  record?: (type: string, result: "sent" | "skipped" | "failed") => void
): Promise<"SENT" | "SKIP"> {
  const row = await port.loadRow(notificationId);
  if (row === null || row.status === "SENT") return "SKIP"; // redelivery / dedup
  // Stays above the try: renderTemplate throws for any unmapped type, so only the three
  // mapped template types can reach a record() call and the `type` label stays bounded.
  const { subject, html } = renderTemplate(row.type, { orderId: row.orderId });
  try {
    await mailer.send({ to: row.to, subject, html }); // throws -> caller retries -> DLQ; row stays PENDING
  } catch (e) {
    record?.(row.type, "failed");
    throw e; // rethrow unchanged: the retry/DLQ behaviour must not change
  }
  const n = await port.casSent(notificationId);
  record?.(row.type, n > 0 ? "sent" : "skipped");
  return n > 0 ? "SENT" : "SKIP"; // a concurrent worker won the CAS
}

const workerPort: WorkerPort = {
  async loadRow(id) {
    const r = await prisma.notification.findUnique({
      where: { id },
      select: { id: true, to: true, type: true, orderId: true, status: true },
    });
    return r ?? null;
  },
  async casSent(id) {
    const r = await prisma.notification.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "SENT", sentAt: new Date() },
    });
    return r.count;
  },
};

export function makeHandleSendEmail(mailer: Mailer, metrics?: NotificationMetrics) {
  return async function handleSendEmail(env: EventEnvelope): Promise<void> {
    const { notificationId } = SendEmailPayloadSchema.parse(env.payload);
    // metrics.observe is an arrow closing over its counter, so the bare reference is safe.
    const outcome = await applySend(workerPort, mailer, notificationId, metrics?.observe);
    log.info("send_email_handled", { notificationId, outcome, traceId: env.traceId });
  };
}
