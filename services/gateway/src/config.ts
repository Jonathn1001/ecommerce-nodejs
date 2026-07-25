import { z } from "zod";
import { loadConfig } from "@ecom/shared";

export const config = loadConfig(
  z.object({
    // Public half only — the gateway verifies, it can never mint.
    JWT_PUBLIC_KEY: z.string().min(1),
    IDENTITY_URL: z.string().url().default("http://localhost:3006"),
    ORDER_URL: z.string().url().default("http://localhost:3002"),
    CATALOG_URL: z.string().url().default("http://localhost:3004"),
    PAYMENT_URL: z.string().url().default("http://localhost:3003"),
    GRANTS_TTL_MS: z.coerce.number().int().positive().default(60_000),
    BREAKER_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    BREAKER_RESET_MS: z.coerce.number().int().positive().default(10_000),
    COOKIE_SECURE: z
      .string()
      .default("false")
      .transform((v) => v === "true"),
    PORT: z.coerce.number().int().positive().default(8000),
    LOG_LEVEL: z.string().default("info"),
  })
);
