import express from "express";
import { traceMiddleware, createLogger } from "@ecom/shared";
import { HELLO_CREATED, HelloCreatedPayloadSchema } from "@ecom/contracts";
import { prisma } from "./db";

const log = createLogger("hello");

export function createApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(traceMiddleware());

  app.post("/hello", async (req, res) => {
    const name = String(req.body?.name ?? "");
    if (!name) return res.status(400).json({ error: "name required" });

    const created = await prisma.$transaction(async (tx) => {
      const rec = await tx.helloRecord.create({ data: { name } });
      const payload = HelloCreatedPayloadSchema.parse({ helloId: rec.id, name: rec.name });
      await tx.outbox.create({
        data: {
          id: rec.id,
          aggregateType: "hello",
          aggregateId: rec.id,
          type: HELLO_CREATED,
          version: 1,
          traceId: req.traceId,
          producer: "hello",
          payload,
        },
      });
      return rec;
    });

    log.info("hello_created", { helloId: created.id, traceId: req.traceId });
    res.status(201).json({ helloId: created.id });
  });

  return app;
}
