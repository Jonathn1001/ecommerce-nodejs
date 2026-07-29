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
import { isMainThread } from "node:worker_threads";

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

// Skip entirely on a non-main thread before touching any guard state. Only the
// main thread of a process ever runs application code in this codebase (none of
// the 8 services spawn worker_threads for request handling). tsx's own loader
// machinery, however, uses a real worker_threads.Worker internally (its esbuild
// transform service) — and because that worker is itself spun up from a process
// whose NODE_OPTIONS still says --import file://tracing.ts, this module gets
// evaluated inside it too, on a thread that will never carry a single span.
// Skipping there is a correctness improvement, not just noise reduction: a
// Worker's globalThis is private to that thread, so its SDK/exporter/instrumentation
// instances would otherwise be unreachable dead weight for the process's entire
// lifetime. If a service ever starts using worker_threads for real application
// work, this line is exactly what to revisit (fix round 1; see task-2-report.md
// for the probe that found tsx's transform worker logging tracing_started).
//
// The remaining guard must live on globalThis, NOT a module-local variable. The
// tsx loader evaluates this module more than once, in SEPARATE module registries
// — a module-local flag is a fresh `false` each time and guards nothing, so the
// SDK would register duplicate exporters and duplicate instrumentations.
//
// Deliberately NOT process.env: env is inherited by a spawned CHILD process, and
// tsx respawns `tsx <file>` into exactly such a child (its own respawn-with-
// loader-flags pattern). An env-based guard set by the parent would be seen as
// already-true by the child — the one process that actually runs application
// code — and skip starting its SDK there, leaving tracing silently dead in the
// process that matters (caught in fix round 1; see task-2-report.md). Each OS
// process that runs code must start its own SDK: under `tsx src/main.ts` that's
// legitimately two processes (the tsx CLI's own bootstrap, then the child it
// respawns into to actually run src/main.ts), so two "tracing_started" lines
// per service start is the expected, correct count — not a duplicate start.
function start(): void {
  if (!isMainThread) return;
  if (globalThis.__ecomTracingStarted__) return;
  globalThis.__ecomTracingStarted__ = true;

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
    log.info("tracing_started", {
      service: process.env.OTEL_SERVICE_NAME ?? "unknown",
      pid: process.pid,
    });
  } catch (e) {
    // Global constraint 1: instrumentation must never take the process down.
    log.warn("tracing_start_failed", { message: (e as Error).message });
  }
}

export function tracingStarted(): boolean {
  return globalThis.__ecomTracingStarted__ === true;
}

start();
