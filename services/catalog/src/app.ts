import express from "express";
import { z } from "zod";
import { traceMiddleware, createLogger, createHealthRouter } from "@ecom/shared";
import { prisma } from "./db";
import { applyCreate, applyUpdate } from "./product";
import { productTx } from "./tx-adapters";

const log = createLogger("catalog");
const CreateSchema = z.object({ type: z.string().min(1), name: z.string().min(1), price: z.number().int().positive(), attributes: z.record(z.unknown()) });
const PatchSchema = z.object({ name: z.string().min(1).optional(), price: z.number().int().positive().optional(), attributes: z.record(z.unknown()).optional() });

export function createApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(traceMiddleware());
  app.use(createHealthRouter({ db: async () => void (await prisma.$queryRaw`SELECT 1`) }));

  app.post("/products", async (req, res) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid product" });
    try {
      const r = await prisma.$transaction((tx) => applyCreate(productTx(tx, req.traceId), parsed.data));
      if (!r.ok) return res.status(400).json({ error: r.error });
      log.info("product_created", { productId: r.productId, traceId: req.traceId });
      return res.status(201).json({ productId: r.productId });
    } catch { log.error("product_create_failed", { traceId: req.traceId }); res.status(500).json({ error: "internal error" }); }
  });

  app.patch("/products/:id", async (req, res) => {
    const parsed = PatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid patch" });
    try {
      const r = await prisma.$transaction((tx) => applyUpdate(productTx(tx, req.traceId), { id: req.params.id, ...parsed.data }));
      if (!r.ok) return res.status(r.error === "not_found" ? 404 : 400).json({ error: r.error });
      log.info("product_updated", { productId: req.params.id, traceId: req.traceId });
      return res.status(200).json({ productId: req.params.id });
    } catch { log.error("product_update_failed", { productId: req.params.id, traceId: req.traceId }); res.status(500).json({ error: "internal error" }); }
  });

  app.get("/products/:id", async (req, res) => {
    const p = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!p) return res.status(404).json({ error: "not found" });
    res.json({ id: p.id, type: p.type, name: p.name, price: p.price, version: p.version, attributes: p.attributes });
  });
  app.get("/products", async (_req, res) => {
    const rows = await prisma.product.findMany({ orderBy: { createdAt: "asc" } });
    res.json(rows.map((p) => ({ id: p.id, type: p.type, name: p.name, price: p.price, version: p.version })));
  });

  return app;
}
