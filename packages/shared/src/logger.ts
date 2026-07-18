import { createLogger as createWinston, format, transports } from "winston";

export type Logger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

// Structured JSON logger. Callers pass ids/codes only — NEVER request bodies,
// passwords, tokens, or email+name pairs (see sensitive-logging rule).
export function createLogger(service: string): Logger {
  const logger = createWinston({
    level: process.env.LOG_LEVEL ?? "info",
    defaultMeta: { service },
    format: format.combine(format.timestamp(), format.json()),
    transports: [new transports.Console()],
  });
  return {
    info: (message, meta) => logger.info(message, meta),
    warn: (message, meta) => logger.warn(message, meta),
    error: (message, meta) => logger.error(message, meta),
  };
}
