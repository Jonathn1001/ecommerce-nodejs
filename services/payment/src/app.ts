import express from "express";
import { traceMiddleware, createLogger, createHealthRouter } from "@ecom/shared";
import { prisma } from "./db";

const log = createLogger("payment");

export function createApp(deps: { rabbitHealth: () => Promise<void> }): express.Application {
  const app = express();
  app.use(express.json());
  app.use(traceMiddleware());

  app.use(
    createHealthRouter({
      db: async () => void (await prisma.$queryRaw`SELECT 1`),
      rabbit: deps.rabbitHealth,
    })
  );

  app.get("/payments/:orderId", async (req, res) => {
    try {
      const p = await prisma.payment.findUnique({ where: { orderId: req.params.orderId } });
      if (!p) return res.status(404).json({ error: "not found" });
      res.json({
        orderId: p.orderId,
        amount: p.amount,
        status: p.status,
        createdAt: p.createdAt.toISOString(),
      });
    } catch {
      log.error("payment_get_failed", { orderId: req.params.orderId, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  return app;
}
