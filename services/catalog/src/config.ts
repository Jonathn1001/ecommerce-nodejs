import { z } from "zod";
import { loadConfig } from "@ecom/shared";

export const config = loadConfig(
  z.object({
    DATABASE_URL: z.string().url(),
    KAFKA_BROKERS: z.string().default("localhost:9092"),
    PORT: z.coerce.number().int().positive().default(3004),
    LOG_LEVEL: z.string().default("info"),
  })
);
