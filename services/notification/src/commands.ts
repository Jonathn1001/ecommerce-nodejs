import { z } from "zod";

// Notification-local command: the dispatcher enqueues it, the outbox relay routes it
// to the RabbitMQ `notifications` queue, the worker consumes it. Carries only the row
// id — the recipient/subject live on the Notification row, never on the wire.
export const SEND_EMAIL = "notification.send_email" as const;
export const SendEmailPayloadSchema = z.object({ notificationId: z.string().min(1) });
export type SendEmailPayload = z.infer<typeof SendEmailPayloadSchema>;
