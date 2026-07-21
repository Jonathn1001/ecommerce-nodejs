import { z } from "zod";
import { loadConfig } from "@ecom/shared";

export const config = loadConfig(
  z.object({
    DATABASE_URL: z.string().url(),
    KAFKA_BROKERS: z.string().default("localhost:9092"),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    RESERVATION_TTL_MS: z.coerce.number().int().positive().default(900_000),
    SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
    PORT: z.coerce.number().int().positive().default(3001),
  })
);
