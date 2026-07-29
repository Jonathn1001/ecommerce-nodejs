import { z } from "zod";
import { loadConfig } from "@ecom/shared";

export const config = loadConfig(
  z.object({
    // Public half only — the gateway verifies, it can never mint. Optional now that a JWKS
    // fetched from identity can serve the same purpose; main.ts asserts at least one is set.
    JWT_PUBLIC_KEY: z.string().min(1).optional(),
    // Set to have the gateway learn identity's signing key(s) by kid instead of a static PEM.
    JWKS_URL: z.string().url().optional(),
    JWKS_TTL_MS: z.coerce.number().int().positive().default(600_000),
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
    // Separate, deliberately unpublished listener: docker-compose.prod.example.yml exposes
    // only PORT, so /metrics must never be mounted there (see app.ts, main.ts). Like every
    // other numeric key here, this MUST default — a metrics port must never be able to stop
    // the gateway from booting.
    METRICS_PORT: z.coerce.number().int().positive().default(9464),
    LOG_LEVEL: z.string().default("info"),
  })
);
