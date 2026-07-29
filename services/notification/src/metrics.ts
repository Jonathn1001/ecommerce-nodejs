import { Counter, type Registry } from "prom-client";

export type SendResult = "sent" | "skipped" | "failed";

export function createNotificationMetrics(registry: Registry) {
  const sent = new Counter({
    name: "notifications_sent_total",
    help: "Notification send attempts by template type and result",
    labelNames: ["type", "result"],
    registers: [registry],
  });
  return { observe: (type: string, result: SendResult) => sent.inc({ type, result }) };
}

export type NotificationMetrics = ReturnType<typeof createNotificationMetrics>;
