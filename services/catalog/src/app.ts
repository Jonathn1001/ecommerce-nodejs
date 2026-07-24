import express from "express";
import { z } from "zod";
import { traceMiddleware, createLogger, createHealthRouter } from "@ecom/shared";
import { prisma } from "./db";
import { applyCreate, applyUpdate } from "./product";
import { productTx } from "./tx-adapters";
import { assembleTree } from "./comments";
import { getDiscountAmount } from "./discount";

const log = createLogger("catalog");
const CreateSchema = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
  price: z.number().int().positive(),
  attributes: z.record(z.unknown()),
});
const PatchSchema = z.object({
  name: z.string().min(1).optional(),
  price: z.number().int().positive().optional(),
  attributes: z.record(z.unknown()).optional(),
});
const CommentSchema = z.object({
  body: z.string().min(1),
  parentId: z.string().min(1).optional(),
});
const DiscountSchema = z.object({
  code: z.string().min(1),
  kind: z.enum(["PERCENT", "FIXED"]),
  value: z.number().int().positive(),
  minOrder: z.number().int().nonnegative().default(0),
  maxUses: z.number().int().positive(),
  maxPerUser: z.number().int().positive(),
  expiresAt: z.string().datetime(),
});
const ApplySchema = z.object({
  userId: z.string().min(1),
  orderTotal: z.number().int().positive(),
});

export function createApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(traceMiddleware());
  app.use(
    createHealthRouter({ db: async () => void (await prisma.$queryRaw`SELECT 1`) })
  );

  app.post("/products", async (req, res) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid product" });
    try {
      const r = await prisma.$transaction((tx) =>
        applyCreate(productTx(tx, req.traceId), parsed.data)
      );
      if (!r.ok) return res.status(400).json({ error: r.error });
      log.info("product_created", { productId: r.productId, traceId: req.traceId });
      return res.status(201).json({ productId: r.productId });
    } catch {
      log.error("product_create_failed", { traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  app.patch("/products/:id", async (req, res) => {
    const parsed = PatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid patch" });
    try {
      const r = await prisma.$transaction((tx) =>
        applyUpdate(productTx(tx, req.traceId), { id: req.params.id, ...parsed.data })
      );
      if (!r.ok)
        return res.status(r.error === "not_found" ? 404 : 400).json({ error: r.error });
      log.info("product_updated", { productId: req.params.id, traceId: req.traceId });
      return res.status(200).json({ productId: req.params.id });
    } catch {
      log.error("product_update_failed", {
        productId: req.params.id,
        traceId: req.traceId,
      });
      res.status(500).json({ error: "internal error" });
    }
  });

  app.get("/products/:id", async (req, res) => {
    try {
      const p = await prisma.product.findUnique({ where: { id: req.params.id } });
      if (!p) return res.status(404).json({ error: "not found" });
      res.json({
        id: p.id,
        type: p.type,
        name: p.name,
        price: p.price,
        version: p.version,
        attributes: p.attributes,
      });
    } catch {
      log.error("product_get_failed", { productId: req.params.id, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });
  app.get("/products", async (req, res) => {
    try {
      const rows = await prisma.product.findMany({ orderBy: { createdAt: "asc" } });
      res.json(
        rows.map((p) => ({
          id: p.id,
          type: p.type,
          name: p.name,
          price: p.price,
          version: p.version,
        }))
      );
    } catch {
      log.error("product_list_failed", { traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  app.post("/products/:id/comments", async (req, res) => {
    const parsed = CommentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid comment" });
    try {
      const product = await prisma.product.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });
      if (!product) return res.status(404).json({ error: "not found" });
      if (parsed.data.parentId) {
        const parent = await prisma.comment.findUnique({
          where: { id: parsed.data.parentId },
          select: { productId: true },
        });
        if (!parent || parent.productId !== req.params.id)
          return res.status(400).json({ error: "bad parent" });
      }
      const c = await prisma.comment.create({
        data: {
          productId: req.params.id,
          parentId: parsed.data.parentId ?? null,
          body: parsed.data.body,
        },
      });
      res.status(201).json({ id: c.id });
    } catch {
      log.error("comment_create_failed", { productId: req.params.id, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  app.get("/products/:id/comments", async (req, res) => {
    try {
      const rows = await prisma.comment.findMany({
        where: { productId: req.params.id },
        orderBy: { createdAt: "asc" },
        select: { id: true, parentId: true, body: true },
      });
      res.json(assembleTree(rows));
    } catch {
      log.error("comment_list_failed", { productId: req.params.id, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  app.delete("/comments/:id", async (req, res) => {
    try {
      const r = await prisma.comment.deleteMany({ where: { id: req.params.id } }); // cascade removes the subtree
      if (r.count === 0) return res.status(404).json({ error: "not found" });
      res.status(200).json({ id: req.params.id });
    } catch {
      log.error("comment_delete_failed", { id: req.params.id, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  app.post("/discounts", async (req, res) => {
    const parsed = DiscountSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid discount" });
    try {
      const d = await prisma.discount.create({
        data: { ...parsed.data, expiresAt: new Date(parsed.data.expiresAt) },
      });
      res.status(201).json({ code: d.code });
    } catch {
      res.status(409).json({ error: "duplicate code" });
    }
  });

  app.get("/discounts/:code", async (req, res) => {
    try {
      const d = await prisma.discount.findUnique({ where: { code: req.params.code } });
      if (!d) return res.status(404).json({ error: "not found" });
      res.json({
        code: d.code,
        kind: d.kind,
        value: d.value,
        minOrder: d.minOrder,
        maxUses: d.maxUses,
        maxPerUser: d.maxPerUser,
        expiresAt: d.expiresAt.toISOString(),
      });
    } catch {
      log.error("discount_get_failed", { code: req.params.code, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  // Row-locked apply: SELECT ... FOR UPDATE serializes concurrent applies for one code
  // so maxUses/maxPerUser cannot be exceeded (count-then-insert TOCTOU otherwise).
  app.post("/discounts/:code/apply", async (req, res) => {
    const parsed = ApplySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid apply" });
    const { userId, orderTotal } = parsed.data;
    try {
      const result = await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<
          Array<{
            id: string;
            kind: string;
            value: number;
            minOrder: number;
            maxUses: number;
            maxPerUser: number;
            expiresAt: Date;
          }>
        >`
          SELECT id, kind, value, "minOrder", "maxUses", "maxPerUser", "expiresAt"
          FROM "Discount" WHERE code = ${req.params.code} FOR UPDATE`;
        if (locked.length === 0) return { status: 404 as const };
        const d = locked[0];
        const totalUses = await tx.discountRedemption.count({
          where: { discountId: d.id },
        });
        const userUses = await tx.discountRedemption.count({
          where: { discountId: d.id, userId },
        });
        const outcome = getDiscountAmount(
          {
            kind: d.kind as "PERCENT" | "FIXED",
            value: d.value,
            minOrder: d.minOrder,
            maxUses: d.maxUses,
            maxPerUser: d.maxPerUser,
            expiresAt: d.expiresAt,
          },
          { orderTotal, totalUses, userUses, now: new Date() }
        );
        if ("ineligible" in outcome)
          return { status: 409 as const, reason: outcome.ineligible };
        await tx.discountRedemption.create({ data: { discountId: d.id, userId } });
        return { status: 200 as const, amount: outcome.amount };
      });
      if (result.status === 404) return res.status(404).json({ error: "not found" });
      if (result.status === 409) return res.status(409).json({ error: result.reason });
      log.info("discount_applied", {
        code: req.params.code,
        userId,
        traceId: req.traceId,
      });
      return res.status(200).json({ amount: result.amount });
    } catch {
      log.error("discount_apply_failed", { code: req.params.code, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  return app;
}
