import express from "express";
import { z } from "zod";
import { createLogger } from "@ecom/shared";
import { prisma } from "./db";

const log = createLogger("identity-grants");

// { roleName: { resourceName: [actions] } } — the shape the gateway caches and enforces on.
export type GrantsSnapshot = Record<string, Record<string, string[]>>;

export async function grantsSnapshot(): Promise<GrantsSnapshot> {
  const rows = await prisma.grant.findMany({ include: { role: true, resource: true } });
  const out: GrantsSnapshot = {};
  for (const g of rows) {
    const role = (out[g.role.name] ??= {});
    (role[g.resource.name] ??= []).push(g.action);
  }
  return out;
}

const NameSchema = z.object({ name: z.string().min(1) });
const GrantSchema = z.object({
  roleName: z.string().min(1),
  resourceName: z.string().min(1),
  action: z.enum(["read", "create", "update", "delete"]),
});

// Admin CRUD over the grants model. Unauthenticated at the service — the gateway is what
// requires an ADMIN role to reach /admin/*, and the prod profile closes this port.
export function grantsRouter(): express.Router {
  const r = express.Router();

  r.get("/admin/roles", async (_req, res) => {
    res.json(await prisma.role.findMany({ orderBy: { name: "asc" } }));
  });

  r.post("/admin/roles", async (req, res) => {
    const p = NameSchema.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: "invalid role" });
    try {
      return res.status(201).json(await prisma.role.create({ data: p.data }));
    } catch (e) {
      if ((e as { code?: string }).code === "P2002")
        return res.status(409).json({ error: "role exists" });
      log.error("role_create_failed", { traceId: req.traceId });
      return res.status(500).json({ error: "internal error" });
    }
  });

  r.get("/admin/resources", async (_req, res) => {
    res.json(await prisma.resource.findMany({ orderBy: { name: "asc" } }));
  });

  r.post("/admin/resources", async (req, res) => {
    const p = NameSchema.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: "invalid resource" });
    try {
      return res.status(201).json(await prisma.resource.create({ data: p.data }));
    } catch (e) {
      if ((e as { code?: string }).code === "P2002")
        return res.status(409).json({ error: "resource exists" });
      log.error("resource_create_failed", { traceId: req.traceId });
      return res.status(500).json({ error: "internal error" });
    }
  });

  r.get("/admin/grants", async (_req, res) => {
    res.json(await prisma.grant.findMany({ include: { role: true, resource: true } }));
  });

  r.post("/admin/grants", async (req, res) => {
    const p = GrantSchema.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: "invalid grant" });
    try {
      const [role, resource] = await Promise.all([
        prisma.role.findUnique({ where: { name: p.data.roleName } }),
        prisma.resource.findUnique({ where: { name: p.data.resourceName } }),
      ]);
      if (!role || !resource)
        return res.status(404).json({ error: "unknown role or resource" });
      const grant = await prisma.grant.create({
        data: { roleId: role.id, resourceId: resource.id, action: p.data.action },
      });
      return res.status(201).json({ id: grant.id });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002")
        return res.status(409).json({ error: "grant exists" });
      log.error("grant_create_failed", { traceId: req.traceId });
      return res.status(500).json({ error: "internal error" });
    }
  });

  r.delete("/admin/grants/:id", async (req, res) => {
    try {
      await prisma.grant.delete({ where: { id: req.params.id } });
      return res.status(204).end();
    } catch {
      return res.status(404).json({ error: "not found" });
    }
  });

  return r;
}
