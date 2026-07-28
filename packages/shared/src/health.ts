import { Router } from "express";

export type ReadinessCheck = () => Promise<void>;

export function createHealthRouter(checks: Record<string, ReadinessCheck> = {}): Router {
  const router = Router();
  router.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  router.get("/readyz", async (_req, res) => {
    const failed: string[] = [];
    await Promise.all(
      Object.entries(checks).map(async ([name, check]) => {
        try {
          await check();
        } catch {
          failed.push(name);
        }
      })
    );
    if (failed.length > 0) return res.status(503).json({ status: "unready", failed });
    res.json({ status: "ready" });
  });
  return router;
}
