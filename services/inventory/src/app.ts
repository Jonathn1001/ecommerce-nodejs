import express from "express";
import { z } from "zod";
import {
  traceMiddleware,
  createLogger,
  createHealthRouter,
  getRedis,
} from "@ecom/shared";
import { prisma } from "./db";

const log = createLogger("inventory");

const AddStockSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().positive(),
  location: z.string().min(1).optional(),
});

export function createApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(traceMiddleware());

  app.use(
    createHealthRouter({
      db: async () => void (await prisma.$queryRaw`SELECT 1`),
      redis: async () => void (await (await getRedis()).ping()),
    })
  );

  // Add/seed stock: upsert the sellable pool. New product => create; existing =>
  // increment. Product validity is Catalog's concern — Inventory trusts productId.
  app.post("/inventory/stock", async (req, res) => {
    const parsed = AddStockSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid stock request" });
    const { productId, quantity, location } = parsed.data;
    try {
      const row = await prisma.inventory.upsert({
        where: { productId },
        create: { productId, available: quantity, ...(location ? { location } : {}) },
        update: { available: { increment: quantity }, ...(location ? { location } : {}) },
      });
      log.info("stock_added", { productId, traceId: req.traceId });
      res.status(201).json({ productId, available: row.available });
    } catch {
      // Never log the caught error or request body — ids/codes only.
      log.error("stock_add_failed", { productId, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  app.get("/inventory/:productId", async (req, res) => {
    const { productId } = req.params;
    try {
      const row = await prisma.inventory.findUnique({ where: { productId } });
      if (!row) return res.status(404).json({ error: "not found" });
      const activeReservations = await prisma.reservation.count({
        where: { productId, status: "ACTIVE" },
      });
      res.json({ productId, available: row.available, activeReservations });
    } catch {
      log.error("stock_query_failed", { productId, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  return app;
}
