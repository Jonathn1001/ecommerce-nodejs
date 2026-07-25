import express from "express";
import { traceMiddleware, createHealthRouter } from "@ecom/shared";
import { prisma } from "./db";

// Health only — Notification has no business routes. It is driven entirely by
// order.events (dispatcher) and the `notifications` Rabbit queue (worker).
export function createApp(deps: {
  rabbitHealth: () => Promise<void>;
}): express.Application {
  const app = express();
  app.use(express.json());
  app.use(traceMiddleware());

  app.use(
    createHealthRouter({
      db: async () => void (await prisma.$queryRaw`SELECT 1`),
      rabbit: deps.rabbitHealth,
    })
  );

  return app;
}
