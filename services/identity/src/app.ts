import express from "express";
import { z } from "zod";
import { traceMiddleware, createLogger, createHealthRouter } from "@ecom/shared";
import { prisma } from "./db";
import { register, login, refresh, logout } from "./auth";
import { grantsRouter, grantsSnapshot } from "./grants";

const log = createLogger("identity");

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
});
const LoginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const RefreshSchema = z.object({ refreshToken: z.string().min(1) });

export function createApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(traceMiddleware());

  app.use(
    createHealthRouter({ db: async () => void (await prisma.$queryRaw`SELECT 1`) })
  );

  app.post("/auth/register", async (req, res) => {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid registration" });
    try {
      const r = await register({ ...parsed.data, traceId: req.traceId });
      if (r.outcome === "DUPLICATE")
        return res.status(409).json({ error: "email already registered" });
      // ids only — never the email or the password.
      log.info("user_registered", { userId: r.userId, traceId: req.traceId });
      return res.status(201).json({ userId: r.userId });
    } catch {
      log.error("register_failed", { traceId: req.traceId });
      return res.status(500).json({ error: "internal error" });
    }
  });

  app.post("/auth/login", async (req, res) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid credentials" });
    try {
      const r = await login(parsed.data);
      if (r.outcome === "REJECTED")
        return res.status(401).json({ error: "invalid credentials" });
      log.info("login_ok", { userId: r.userId, traceId: req.traceId });
      return res.status(200).json(r.tokens);
    } catch {
      log.error("login_failed", { traceId: req.traceId });
      return res.status(500).json({ error: "internal error" });
    }
  });

  app.post("/auth/refresh", async (req, res) => {
    const parsed = RefreshSchema.safeParse(req.body);
    if (!parsed.success) return res.status(401).json({ error: "invalid refresh token" });
    try {
      const r = await refresh(parsed.data.refreshToken);
      if (r.outcome === "REJECTED") {
        log.info("refresh_rejected", { reason: r.reason, traceId: req.traceId });
        return res.status(401).json({ error: "invalid refresh token" });
      }
      return res.status(200).json(r.tokens);
    } catch {
      log.error("refresh_failed", { traceId: req.traceId });
      return res.status(500).json({ error: "internal error" });
    }
  });

  app.post("/auth/logout", async (req, res) => {
    const parsed = RefreshSchema.safeParse(req.body);
    if (!parsed.success) return res.status(204).end(); // logging out twice is not an error
    try {
      await logout(parsed.data.refreshToken);
      return res.status(204).end();
    } catch {
      log.error("logout_failed", { traceId: req.traceId });
      return res.status(500).json({ error: "internal error" });
    }
  });

  // Server-to-server only: the gateway caches this snapshot and enforces on it. The gateway
  // never proxies /internal/* from the outside.
  app.get("/internal/grants", async (req, res) => {
    try {
      return res.status(200).json(await grantsSnapshot());
    } catch {
      log.error("grants_snapshot_failed", { traceId: req.traceId });
      return res.status(500).json({ error: "internal error" });
    }
  });

  app.use(grantsRouter());

  return app;
}
