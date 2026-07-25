import { createLogger, type Logger } from "@ecom/shared";
import { type EventEnvelope } from "@ecom/contracts";
import { prisma } from "./db";
import { renderTemplate } from "./templates";
import { SendEmailPayloadSchema } from "./commands";
import type { Mailer } from "./mailer";

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

export async function applySend(
  port: WorkerPort,
  mailer: Mailer,
  notificationId: string
): Promise<"SENT" | "SKIP"> {
  const row = await port.loadRow(notificationId);
  if (row === null || row.status === "SENT") return "SKIP"; // redelivery / dedup
  const { subject, html } = renderTemplate(row.type, { orderId: row.orderId });
  await mailer.send({ to: row.to, subject, html }); // throws -> caller retries -> DLQ; row stays PENDING
  const n = await port.casSent(notificationId);
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

export function makeHandleSendEmail(mailer: Mailer) {
  return async function handleSendEmail(env: EventEnvelope): Promise<void> {
    const { notificationId } = SendEmailPayloadSchema.parse(env.payload);
    const outcome = await applySend(workerPort, mailer, notificationId);
    log.info("send_email_handled", { notificationId, outcome, traceId: env.traceId });
  };
}
