import express from "express";
import { z } from "zod";
import { traceMiddleware, createLogger, createHealthRouter } from "@ecom/shared";
import { prisma } from "./db";
import { finalizePayment } from "./resolve";
import { resolveTx } from "./tx-adapters";

const log = createLogger("payment");

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

  app.get("/payments/:orderId", async (req, res) => {
    try {
      const p = await prisma.payment.findUnique({
        where: { orderId: req.params.orderId },
      });
      if (!p) return res.status(404).json({ error: "not found" });
      res.json({
        orderId: p.orderId,
        amount: p.amount,
        status: p.status,
        createdAt: p.createdAt.toISOString(),
      });
    } catch {
      log.error("payment_get_failed", {
        orderId: req.params.orderId,
        traceId: req.traceId,
      });
      res.status(500).json({ error: "internal error" });
    }
  });

  const WebhookSchema = z.object({
    orderId: z.string().min(1),
    outcome: z.enum(["SUCCEEDED", "FAILED"]),
  });

  // Simulated-provider callback resolving a PROCESSING payment. Unauthenticated
  // (Phase 6 gateway / HMAC later). Concurrent-safe via compare-and-set.
  app.post("/webhooks/payment", async (req, res) => {
    const parsed = WebhookSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid webhook" });
    const { orderId, outcome } = parsed.data;
    try {
      const r = await prisma.$transaction((tx) =>
        finalizePayment(resolveTx(tx, req.traceId), { orderId, outcome })
      );
      if (r === "NOT_FOUND") return res.status(404).json({ error: "not found" });
      log.info("webhook_resolved", { orderId, outcome, result: r, traceId: req.traceId });
      return res.status(200).json({ orderId, result: r }); // FINALIZED or NOOP
    } catch {
      log.error("webhook_failed", { orderId, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  return app;
}
