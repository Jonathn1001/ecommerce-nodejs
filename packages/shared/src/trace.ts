import type { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { createLogger } from "./logger";

export const TRACE_HEADER = "x-trace-id";
const log = createLogger("http");

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      traceId: string;
    }
  }
}

export function traceMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header(TRACE_HEADER);
    const traceId = incoming && incoming.length > 0 ? incoming : uuidv4();
    req.traceId = traceId;
    res.setHeader(TRACE_HEADER, traceId);
    // Metadata only — method, path, traceId. NEVER body or query values.
    log.info("http_request", { method: req.method, path: req.path, traceId });
    next();
  };
}
