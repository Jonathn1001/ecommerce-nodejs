import express from "express";
import { z } from "zod";
import {
  traceMiddleware,
  createLogger,
  createHealthRouter,
  createMetrics,
  type Metrics,
} from "@ecom/shared";
import { prisma } from "./db";
import { finalizePayment, refundPayment } from "./resolve";
import { resolveTx } from "./tx-adapters";
import { config } from "./config";
import { verifyWebhookSignature } from "./webhook-signature";

const log = createLogger("payment");

export function createApp(deps: {
  rabbitHealth: () => Promise<void>;
  metrics?: Metrics;
}): express.Application {
  const metrics = deps.metrics ?? createMetrics("payment");
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );
  app.use(traceMiddleware());
  app.use(metrics.httpMiddleware());
  app.use(metrics.router());

  app.use(
    createHealthRouter({
      db: async () => void (await prisma.$queryRaw`SELECT 1`),
      rabbit: deps.rabbitHealth,
    })
  );

  // The caller's identity is the x-user-id header, which ONLY the gateway may set: it strips
  // any client-supplied copy before injecting the value it verified from the JWT (Phase 6).
  // Direct access to this port is closed in the prod compose profile.
  app.get("/payments/:orderId", async (req, res) => {
    const callerId = req.header("x-user-id");
    if (!callerId) return res.status(400).json({ error: "missing x-user-id" });
    try {
      const p = await prisma.payment.findUnique({
        where: { orderId: req.params.orderId },
      });
      // A payment belonging to someone else — or to nobody (a legacy row) — is reported
      // absent, not forbidden, so order ids stay unenumerable.
      if (!p || p.userId !== callerId)
        return res.status(404).json({ error: "not found" });
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

  // Simulated-provider callback resolving a PROCESSING payment. Authenticated via an
  // HMAC-SHA256 signature over the raw body (see webhook-signature.ts) — this is what
  // replaces auth for a route the gateway leaves CSRF-exempt and un-authed.
  // Concurrent-safe via compare-and-set.
  app.post("/webhooks/payment", async (req, res) => {
    const raw =
      (req as express.Request & { rawBody?: Buffer }).rawBody ?? Buffer.from("");
    if (
      !verifyWebhookSignature(
        raw,
        req.header("x-webhook-signature"),
        config.PAYMENT_WEBHOOK_SECRET
      )
    ) {
      log.error("webhook_signature_rejected", { traceId: req.traceId });
      return res.status(401).json({ error: "invalid signature" });
    }
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

  // Admin refund stub — marks a SUCCEEDED payment REFUNDED and emits payment.refunded.
  // No consumer this slice. Unauthenticated (Phase 6). Concurrent-safe via CAS.
  app.post("/admin/payments/:orderId/refund", async (req, res) => {
    const { orderId } = req.params;
    try {
      const r = await prisma.$transaction((tx) =>
        refundPayment(resolveTx(tx, req.traceId), { orderId })
      );
      if (r === "NOT_FOUND") return res.status(404).json({ error: "not found" });
      if (r === "NOT_REFUNDABLE")
        return res.status(409).json({ error: "not refundable", orderId });
      log.info("refund_handled", { orderId, result: r, traceId: req.traceId });
      return res.status(200).json({ orderId, result: r }); // REFUNDED or NOOP
    } catch {
      log.error("refund_failed", { orderId, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  return app;
}
