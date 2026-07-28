import { z } from "zod";
import { loadConfig } from "@ecom/shared";

export const config = loadConfig(
  z.object({
    DATABASE_URL: z.string().url(),
    KAFKA_BROKERS: z.string().default("localhost:9092"),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    PORT: z.coerce.number().int().positive().default(3000),
  })
);
