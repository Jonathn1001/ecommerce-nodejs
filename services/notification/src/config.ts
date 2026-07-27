import { z } from "zod";
import { loadConfig } from "@ecom/shared";

export const config = loadConfig(
  z.object({
    DATABASE_URL: z.string().url(),
    KAFKA_BROKERS: z.string().default("localhost:9092"),
    RABBITMQ_URL: z.string().default("amqp://ecom:ecom@localhost:5672"),
    SMTP_HOST: z.string().default("localhost"),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    NOTIFY_EMAIL_DOMAIN: z.string().default("example.test"),
    RABBIT_PREFETCH: z.coerce.number().int().positive().default(10),
    LEDGER_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
    LEDGER_PRUNE_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
    PORT: z.coerce.number().int().positive().default(3005),
    LOG_LEVEL: z.string().default("info"),
  })
);
