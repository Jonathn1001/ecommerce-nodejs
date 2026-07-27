import { z } from "zod";
import { loadConfig } from "@ecom/shared";

export const config = loadConfig(
  z.object({
    DATABASE_URL: z.string().url(),
    RABBITMQ_URL: z.string().default("amqp://ecom:ecom@localhost:5672"),
    KAFKA_BROKERS: z.string().default("localhost:9092"),
    LEDGER_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
    LEDGER_PRUNE_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
    PORT: z.coerce.number().int().positive().default(3003),
    LOG_LEVEL: z.string().default("info"),
  })
);
