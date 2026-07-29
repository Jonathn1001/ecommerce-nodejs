import express from "express";
import {
  traceMiddleware,
  createHealthRouter,
  createMetrics,
  type Metrics,
} from "@ecom/shared";
import { prisma } from "./db";

// Health only — Notification has no business routes. It is driven entirely by
// order.events (dispatcher) and the `notifications` Rabbit queue (worker).
export function createApp(deps: {
  rabbitHealth: () => Promise<void>;
  metrics?: Metrics;
}): express.Application {
  const metrics = deps.metrics ?? createMetrics("notification");
  const app = express();
  app.use(express.json());
  app.use(traceMiddleware());
  app.use(metrics.httpMiddleware());
  app.use(metrics.router());

  app.use(
    createHealthRouter({
      db: async () => void (await prisma.$queryRaw`SELECT 1`),
      rabbit: deps.rabbitHealth,
    })
  );

  return app;
}
