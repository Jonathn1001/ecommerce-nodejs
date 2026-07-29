// Preload module, loaded via NODE_OPTIONS=--import. NOT exported from index.ts:
// importing it as a library would start the SDK inside every service and every test.
//
// Deliberately has NO relative imports (not even "./logger"). tsx's --import hook
// resolves this file through a synchronous, worker-mediated resolution path, and
// pairing that with a *relative* specifier that itself needs further resolution
// (as "./logger" does, into "winston") deadlocks the process before it ever reaches
// this file's first statement — reproduced deterministically against tsx 4.23.1 /
// Node 22.21.1, independent of the relative specifier's extension. Bare package
// specifiers (below) do not hit this path. See task-2-report.md for the repro.
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { RedisInstrumentation } from "@opentelemetry/instrumentation-redis";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { createLogger as createWinston, format, transports } from "winston";

// Inlined rather than imported from "./logger" — see note above. Same shape/output
// as the shared logger (structured JSON on stdout via winston).
const log = createWinston({
  level: process.env.LOG_LEVEL ?? "info",
  defaultMeta: { service: "tracing" },
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

// The set is explicit, never getNodeAutoInstrumentations(): that bundle includes
// kafkajs and amqplib, which propagate through broker headers and would compete
// with this system's envelope-carried context. It also includes fs, which buries
// a trace in hundreds of spans.
export const ENABLED_INSTRUMENTATIONS = [
  "@opentelemetry/instrumentation-http",
  "@opentelemetry/instrumentation-express",
  "@opentelemetry/instrumentation-redis",
  "@prisma/instrumentation",
] as const;

declare global {
  // eslint-disable-next-line no-var
  var __ecomTracingStarted__: boolean | undefined;
}

// Must live on globalThis, NOT in a module-local variable. The tsx loader evaluates
// this module more than once, in SEPARATE module registries — a module-local flag is
// a fresh `false` each time and guards nothing, so the SDK would register duplicate
// exporters and duplicate instrumentations.
//
// globalThis alone is not sufficient, though: verified in Step 6 that `tsx <file>`
// re-execs itself into a CHILD process (its own respawn-with-loader-flags pattern),
// and NODE_OPTIONS applies to that child too — so this module evaluates a second
// time in a genuinely separate process with its own globalThis, which no in-process
// flag can see across. process.env, unlike globalThis, both survives this module's
// own re-evaluation AND is inherited by that spawned child (env is copied at spawn
// time), so it is the guard that actually covers the case this file is loaded for.
function start(): void {
  if (globalThis.__ecomTracingStarted__ || process.env.__ECOM_TRACING_STARTED__) return;
  globalThis.__ecomTracingStarted__ = true;
  process.env.__ECOM_TRACING_STARTED__ = "true";

  try {
    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter(),
      instrumentations: [
        new HttpInstrumentation(),
        new ExpressInstrumentation(),
        new RedisInstrumentation(),
        new PrismaInstrumentation(),
      ],
    });
    sdk.start();
    process.once("SIGTERM", () => {
      void sdk.shutdown().catch(() => {
        /* shutdown telemetry must never delay or fail process exit */
      });
    });
    log.info("tracing_started", { service: process.env.OTEL_SERVICE_NAME ?? "unknown" });
  } catch (e) {
    // Global constraint 1: instrumentation must never take the process down.
    log.warn("tracing_start_failed", { message: (e as Error).message });
  }
}

export function tracingStarted(): boolean {
  return globalThis.__ecomTracingStarted__ === true;
}

start();
