import { z } from "zod";
import { loadConfig } from "@ecom/shared";

export const config = loadConfig(
  z.object({
    DATABASE_URL: z.string().url(),
    KAFKA_BROKERS: z.string().default("localhost:9092"),
    // PEM. Identity is the ONLY holder of the private key — the gateway verifies with the
    // public half, so a gateway compromise cannot mint tokens.
    JWT_PRIVATE_KEY: z.string().min(1),
    ACCESS_TTL: z.string().default("15m"),
    REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
    BCRYPT_COST: z.coerce.number().int().positive().default(10),
    LEDGER_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
    LEDGER_PRUNE_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
    PORT: z.coerce.number().int().positive().default(3006),
    LOG_LEVEL: z.string().default("info"),
  })
);
