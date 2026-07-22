import express from "express";
import { z } from "zod";
import { traceMiddleware, createLogger, createHealthRouter } from "@ecom/shared";
import { prisma } from "./db";

const log = createLogger("order");

const AddItemSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().positive(),
});
const SetQtySchema = z.object({ quantity: z.number().int().min(0) });
const AdminCatalogSchema = z.object({
  productId: z.string().min(1),
  name: z.string().min(1),
  price: z.number().int().positive(),
});

// Temporary auth stand-in: the caller's identity is the x-user-id header until
// Gateway/Identity provide real JWT-over-cookie auth.
function userIdOf(req: express.Request): string | null {
  const raw = req.header("x-user-id");
  return raw && raw.length > 0 ? raw : null;
}

export function createApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(traceMiddleware());

  app.use(
    createHealthRouter({
      db: async () => void (await prisma.$queryRaw`SELECT 1`),
    })
  );

  // Add/increment a cart line. Upsert the Cart parent first (FK), then the line.
  app.post("/cart/items", async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(400).json({ error: "missing x-user-id" });
    const parsed = AddItemSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid cart item" });
    const { productId, quantity } = parsed.data;
    try {
      await prisma.$transaction([
        prisma.cart.upsert({ where: { userId }, create: { userId }, update: {} }),
        prisma.cartItem.upsert({
          where: { userId_productId: { userId, productId } },
          create: { userId, productId, quantity },
          update: { quantity: { increment: quantity } },
        }),
      ]);
      res.status(201).json({ productId });
    } catch {
      log.error("cart_add_failed", { productId, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  // Set a line's quantity; 0 removes it.
  app.patch("/cart/items/:productId", async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(400).json({ error: "missing x-user-id" });
    const parsed = SetQtySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid quantity" });
    const { productId } = req.params;
    const { quantity } = parsed.data;
    try {
      if (quantity === 0) {
        await prisma.cartItem.deleteMany({ where: { userId, productId } });
        return res.status(200).json({ productId, quantity: 0 });
      }
      const r = await prisma.cartItem.updateMany({ where: { userId, productId }, data: { quantity } });
      if (r.count === 0) return res.status(404).json({ error: "not in cart" });
      res.status(200).json({ productId, quantity });
    } catch {
      log.error("cart_set_failed", { productId, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  app.delete("/cart/items/:productId", async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(400).json({ error: "missing x-user-id" });
    const { productId } = req.params;
    try {
      await prisma.cartItem.deleteMany({ where: { userId, productId } });
      res.status(200).json({ productId });
    } catch {
      log.error("cart_delete_failed", { productId, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  app.get("/cart", async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(400).json({ error: "missing x-user-id" });
    try {
      const cart = await prisma.cart.findUnique({ where: { userId }, include: { items: true } });
      const items = (cart?.items ?? [])
        .map((i) => ({ productId: i.productId, quantity: i.quantity }))
        .sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
      res.json({ userId, items });
    } catch {
      log.error("cart_get_failed", { traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  // Catalog price stand-in: upsert the local read-model row. Replaced by a
  // Catalog PriceChanged projection later.
  app.post("/admin/catalog", async (req, res) => {
    const parsed = AdminCatalogSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid catalog entry" });
    const { productId, name, price } = parsed.data;
    try {
      const row = await prisma.catalogReadModel.upsert({
        where: { productId },
        create: { productId, name, price },
        update: { name, price },
      });
      res.status(201).json({ productId: row.productId, price: row.price });
    } catch {
      log.error("catalog_upsert_failed", { productId, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  return app;
}
