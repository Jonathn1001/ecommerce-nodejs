import express from "express";
import { z } from "zod";
import { traceMiddleware, createLogger, createHealthRouter } from "@ecom/shared";
import { prisma } from "./db";
import { placeOrder } from "./place-order";
import { placeOrderTx } from "./tx-adapters";
import { SubscriberRegistry, type Sink } from "./sse-listener";

const log = createLogger("order");

const AddItemSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().positive(),
});
const SetQtySchema = z.object({ quantity: z.number().int().min(0) });

// Temporary auth stand-in: the caller's identity is the x-user-id header until
// Gateway/Identity provide real JWT-over-cookie auth.
function userIdOf(req: express.Request): string | null {
  const raw = req.header("x-user-id");
  return raw && raw.length > 0 ? raw : null;
}

export function createApp(
  deps: { sseRegistry?: SubscriberRegistry } = {}
): express.Application {
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
      const r = await prisma.cartItem.updateMany({
        where: { userId, productId },
        data: { quantity },
      });
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
      const cart = await prisma.cart.findUnique({
        where: { userId },
        include: { items: true },
      });
      const items = (cart?.items ?? [])
        .map((i) => ({ productId: i.productId, quantity: i.quantity }))
        .sort((a, b) =>
          a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0
        );
      res.json({ userId, items });
    } catch {
      log.error("cart_get_failed", { traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  // Place the current user's cart. Cart read + pricing + order write + cart
  // clear + outbox insert all commit in one transaction.
  app.post("/orders", async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(400).json({ error: "missing x-user-id" });
    try {
      const result = await prisma.$transaction(async (tx) => {
        const cart = await tx.cart.findUnique({
          where: { userId },
          include: { items: true },
        });
        const items = (cart?.items ?? []).map((i) => ({
          productId: i.productId,
          quantity: i.quantity,
        }));
        const r = await placeOrder(placeOrderTx(tx, req.traceId), { userId, items });
        if (r.outcome !== "PLACED") {
          return {
            outcome: r.outcome,
            unpricedProductId: r.unpricedProductId,
            order: null,
          };
        }
        const order = await tx.order.findUnique({
          where: { id: r.orderId! },
          include: { items: true },
        });
        return { outcome: r.outcome, unpricedProductId: undefined, order };
      });

      if (result.outcome === "EMPTY")
        return res.status(400).json({ error: "cart is empty" });
      if (result.outcome === "UNPRICED")
        return res
          .status(422)
          .json({ error: "unpriced product", productId: result.unpricedProductId });

      const order = result.order!;
      log.info("order_placed", { orderId: order.id, traceId: req.traceId });
      res.status(201).json({
        orderId: order.id,
        status: order.status,
        totalPrice: order.totalPrice,
        items: order.items.map((i) => ({
          productId: i.productId,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
        })),
      });
    } catch {
      log.error("order_place_failed", { traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  app.get("/orders/:id", async (req, res) => {
    try {
      const order = await prisma.order.findUnique({
        where: { id: req.params.id },
        include: { items: true },
      });
      if (!order) return res.status(404).json({ error: "not found" });
      res.json({
        id: order.id,
        userId: order.userId,
        status: order.status,
        totalPrice: order.totalPrice,
        items: order.items.map((i) => ({
          productId: i.productId,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
        })),
        createdAt: order.createdAt.toISOString(),
      });
    } catch {
      log.error("order_get_failed", { orderId: req.params.id, traceId: req.traceId });
      res.status(500).json({ error: "internal error" });
    }
  });

  // Live order-status stream (SSE). One frame per transition; closes on terminal.
  app.get("/orders/:id/stream", async (req, res) => {
    const registry = deps.sseRegistry;
    if (!registry) return res.status(503).json({ error: "stream unavailable" });
    const id = req.params.id;
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    try {
      // 404 before any SSE headers.
      const exists = await prisma.order.findUnique({ where: { id }, select: { id: true } });
      if (!exists) return res.status(404).json({ error: "not found" });

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const sink: Sink = {
        send: (f) => {
          if (!res.writableEnded) res.write(`event: status\ndata: ${JSON.stringify(f)}\n\n`);
        },
        end: () => {
          if (heartbeat) clearInterval(heartbeat);
          if (!res.writableEnded) res.end();
        },
      };
      // Register BEFORE reading current status so a transition landing during the
      // read is still delivered (a rare initial==first-notify overlap is deduped
      // client-side by status).
      unsubscribe = registry.subscribe(id, sink);

      const current = await prisma.order.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!res.writableEnded) {
        if (!current) {
          // Order vanished between the existence check and this read — close cleanly.
          unsubscribe();
          return res.end();
        }
        sink.send({ orderId: id, status: current.status });
        if (current.status === "CONFIRMED" || current.status === "CANCELLED") {
          unsubscribe();
          return res.end();
        }
      }

      heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(":keepalive\n\n");
      }, 15000);
      req.on("close", () => {
        if (heartbeat) clearInterval(heartbeat);
        if (unsubscribe) unsubscribe();
      });
    } catch {
      log.error("order_stream_failed", { orderId: id, traceId: req.traceId });
      if (unsubscribe) unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      if (!res.headersSent) return res.status(500).json({ error: "internal error" });
      if (!res.writableEnded) res.end();
    }
  });

  return app;
}
