// Fixture for tracing.int.test.ts. Deliberately tiny and self-contained: this is
// the "application code" a real service would run after the tracing preload has
// evaluated. It starts a span and reports the resulting trace id on stdout, then
// exits immediately — before the SDK's batch export interval could ever fire, so
// this needs no live OTLP collector even though the test also sets
// OTEL_TRACES_EXPORTER=none belt-and-braces.
//
// Not run directly by vitest — spawned as a child process by tracing.int.test.ts
// with NODE_OPTIONS pointing at ../tracing.ts, the same way a real service starts.
import { trace } from "@opentelemetry/api";

const span = trace.getTracer("tracing-fixture").startSpan("fixture-span");
const { traceId } = span.spanContext();
span.end();

process.stdout.write(JSON.stringify({ traceId }) + "\n");
process.exit(0);
