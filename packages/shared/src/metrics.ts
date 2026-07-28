import { Router, type Request, type RequestHandler } from "express";
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";
import { createLogger } from "./logger";

const log = createLogger("metrics");

export type DlqProbe = (queue: string) => Promise<number>;

export interface KafkaMetricsHooks {
  onBatch(p: { group: string; topic: string; partition: string; lag: number }): void;
  onMessage(p: { group: string; topic: string; result: "ok" | "dlq" }): void;
  observeHandler(p: {
    group: string;
    topic: string;
    type: string;
    seconds: number;
  }): void;
}

export interface Metrics {
  registry: Registry;
  httpMiddleware(): RequestHandler;
  router(): Router;
  kafkaHooks: KafkaMetricsHooks;
  startDlqPoller(
    probe: DlqProbe,
    queues: string[],
    opts?: { intervalMs?: number }
  ): { stop(): void };
}

// Straddles the p95 < 500ms SLO so the quantile interpolates from real bucket edges.
const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

// `upstream` is "" everywhere except the gateway, where proxy mounts name their target.
// A constant empty label costs no cardinality and keeps one middleware for all services.
// `service` is carried as an explicit label here rather than via registry.setDefaultLabels:
// setDefaultLabels stamps every metric family in the registry, including the kafka/DLQ
// gauges below, which must stay free of it to keep their label sets small and predictable.
const HTTP_LABELS = ["method", "route", "status", "upstream", "service"] as const;

export function resolveRoute(req: Request, metricsRoute?: string): string {
  if (metricsRoute) return metricsRoute;
  // Express restores baseUrl only when a handler calls next(); handlers that end the
  // response never trigger the restore, so both fields are still set at `finish` time.
  if (req.route) return `${req.baseUrl}${req.route.path}`;
  if (req.baseUrl) return req.baseUrl;
  return "unmatched";
}

export function createMetrics(
  serviceName: string,
  opts: { defaultMetrics?: boolean } = {}
): Metrics {
  const registry = new Registry();

  // Off by default: collectDefaultMetrics starts an interval with no per-registry stop
  // handle, so calling it from every createApp() in every test file leaks collectors and
  // hangs vitest on open handles. Only main.ts opts in.
  if (opts.defaultMetrics) collectDefaultMetrics({ register: registry });

  const httpRequests = new Counter({
    name: "http_requests_total",
    help: "HTTP requests handled",
    labelNames: HTTP_LABELS,
    registers: [registry],
  });
  const httpDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: HTTP_LABELS,
    buckets: HTTP_BUCKETS,
    registers: [registry],
  });
  const kafkaLag = new Gauge({
    name: "kafka_consumer_lag",
    help: "Offset lag for partitions this consumer owns",
    labelNames: ["group", "topic", "partition"],
    registers: [registry],
  });
  const kafkaMessages = new Counter({
    name: "kafka_messages_total",
    help: "Kafka messages consumed by outcome",
    labelNames: ["group", "topic", "result"],
    registers: [registry],
  });
  const kafkaHandler = new Histogram({
    name: "kafka_handler_duration_seconds",
    help: "Consumer handler duration in seconds",
    labelNames: ["group", "topic", "type"],
    buckets: HTTP_BUCKETS,
    registers: [registry],
  });
  const dlqDepth = new Gauge({
    name: "rabbitmq_dlq_depth",
    help: "Messages sitting in a dead-letter queue",
    labelNames: ["queue"],
    registers: [registry],
  });

  function httpMiddleware(): RequestHandler {
    return (req, res, next) => {
      const start = process.hrtime.bigint();
      res.on("finish", () => {
        try {
          const labels = {
            method: req.method,
            route: resolveRoute(req, res.locals.metricsRoute as string | undefined),
            status: String(res.statusCode),
            upstream: (res.locals.metricsUpstream as string | undefined) ?? "",
            service: serviceName,
          };
          httpRequests.inc(labels);
          httpDuration.observe(labels, Number(process.hrtime.bigint() - start) / 1e9);
        } catch (e) {
          log.error("metrics_http_record_failed", { message: (e as Error).message });
        }
      });
      next();
    };
  }

  function router(): Router {
    const r = Router();
    // registry.metrics() is async — an unguarded rejection here crashes the process.
    r.get("/metrics", async (_req, res) => {
      try {
        res.setHeader("Content-Type", registry.contentType);
        res.send(await registry.metrics());
      } catch (e) {
        log.error("metrics_scrape_failed", { message: (e as Error).message });
        res.status(500).send("");
      }
    });
    return r;
  }

  const kafkaHooks: KafkaMetricsHooks = {
    onBatch: ({ group, topic, partition, lag }) =>
      kafkaLag.set({ group, topic, partition }, lag),
    onMessage: ({ group, topic, result }) => kafkaMessages.inc({ group, topic, result }),
    observeHandler: ({ group, topic, type, seconds }) =>
      kafkaHandler.observe({ group, topic, type }, seconds),
  };

  function startDlqPoller(
    probe: DlqProbe,
    queues: string[],
    o: { intervalMs?: number } = {}
  ) {
    const intervalMs = o.intervalMs ?? 15_000;
    const tick = async () => {
      for (const q of queues) {
        try {
          dlqDepth.set({ queue: q }, await probe(q));
        } catch (e) {
          // Leave the gauge at its last value and keep polling — a metric must never
          // take the process down, and a stale gauge is better than a dead poller.
          log.error("dlq_probe_failed", { queue: q, message: (e as Error).message });
        }
      }
    };
    const handle = setInterval(() => void tick(), intervalMs);
    return { stop: () => clearInterval(handle) };
  }

  return { registry, httpMiddleware, router, kafkaHooks, startDlqPoller };
}
