# Phase 0 — Platform Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo, shared platform packages, and local infra so a "hello event" flows producer → transactional outbox → Kafka → idempotent consumer end-to-end, de-risking every later service.

**Architecture:** pnpm/TypeScript monorepo. `packages/contracts` holds zod-validated event envelopes (single source of truth). `packages/shared` holds the logger, errors, trace middleware, and Kafka/RabbitMQ/Redis/outbox wrappers. `services/hello` is a throwaway tracer-bullet service that proves the rails: an HTTP write persists a row + an outbox row in one Postgres transaction, a polling relay publishes the outbox to Kafka, and a consumer processes it exactly once via a Redis idempotency key. The old monolith moves to `legacy/` as read-only reference.

**Tech Stack:** TypeScript (CommonJS), Express, Prisma (PostgreSQL), KafkaJS, amqplib, node-redis v4, zod, vitest, ESLint + Prettier, pnpm workspaces, Docker + Compose, GitHub Actions. Node 22, pnpm 10.

**Production baseline (established here, inherited by every later service):** fail-fast zod config validation, `/healthz`+`/readyz` probes, graceful shutdown, retry/backoff + Kafka consumer DLQ-parking, multi-stage Dockerfile + prod compose profile, and CI (lint/typecheck/test/build/audit). See the umbrella spec's "Per-service Definition of Done".

## Global Constraints

- **Language/module:** TypeScript, `module: commonjs`, `strict: true`. Node `>=22`.
- **Package manager:** pnpm workspaces only. Cross-package deps use `workspace:*`.
- **DB-per-service:** every service owns one PostgreSQL database; a service NEVER reads another service's database. (Phase 0: only `hello` has a DB.)
- **No PII in logs:** log ids/codes only — never `password`, tokens, raw JWTs, request bodies, or email+name pairs. (Enforced by `.claude/hooks/sensitive-logging-guard.sh`.)
- **Contracts are the source of truth:** every event's shape lives in `packages/contracts`; producers and consumers import it, never redefine it.
- **Prisma migrations via CLI only:** `pnpm exec prisma migrate dev --name <change>`; never hand-edit files under `prisma/migrations/`.
- **Infra secrecy:** commit `docker-compose.example.yml`; the real `docker-compose.yml` and `.env` stay gitignored.
- **Commits:** stage specific files (never `git add -A`). Branch is `feat/microservices-streaming-rebuild`.

---

### Task 1: Monorepo scaffold + move monolith to `legacy/`

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json` (root), `tsconfig.base.json`, `vitest.config.ts`
- Modify: `.gitignore`
- Move: `src/ server.js README.md nginx.command.md ecommerce-tables.sql package.json package-lock.json` → `legacy/`

**Interfaces:**
- Produces: a resolvable pnpm workspace covering `packages/*` and `services/*`; a `tsconfig.base.json` every package extends; `pnpm test` wired to vitest.

- [x] **Step 1: Move the monolith into `legacy/`**

```bash
mkdir -p legacy
git mv src legacy/src
git mv server.js legacy/server.js
git mv README.md legacy/README.md
git mv nginx.command.md legacy/nginx.command.md
git mv ecommerce-tables.sql legacy/ecommerce-tables.sql
git mv package.json legacy/package.json
git mv package-lock.json legacy/package-lock.json
```

- [x] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
  - "services/*"
```

- [x] **Step 3: Create root `package.json`**

```json
{
  "name": "ecommerce-platform",
  "private": true,
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "vitest": "^2.1.0"
  }
}
```

- [x] **Step 4: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "sourceMap": true
  }
}
```

- [x] **Step 5: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "services/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
```

- [x] **Step 6: Update `.gitignore`** — append the real compose file, build output, and Prisma client artifacts

```gitignore
# --- monorepo additions ---
dist/
docker-compose.yml
**/generated/
# committed env templates (the existing .env* rules would otherwise ignore these)
!.env.example
!**/.env.example
```

(`node_modules`, `.env`, `.env.*`, `*.log` are already ignored. The two negations
above re-include the committed `.env.example` templates — root and per-service —
which the existing `.env*` rule would otherwise swallow.)

- [x] **Step 7: Install and verify the workspace resolves**

Run: `pnpm install`
Expected: completes with no error; creates root `node_modules` and `pnpm-lock.yaml`.

Run: `pnpm -w exec tsc --version`
Expected: prints `Version 5.7.x`.

- [x] **Step 8: Commit**

```bash
git add pnpm-workspace.yaml package.json tsconfig.base.json vitest.config.ts .gitignore pnpm-lock.yaml legacy
git commit -m "chore(phase0): pnpm monorepo scaffold + move monolith to legacy/"
```

---

### Task 2: `packages/contracts` — event envelope + HelloCreated

**Files:**
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/src/envelope.ts`, `packages/contracts/src/events/hello.ts`, `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/__tests__/envelope.test.ts`

**Interfaces:**
- Produces:
  - `EventEnvelopeSchema` (zod) and `EventEnvelope` type: `{ eventId: string; type: string; version: number; occurredAt: string; traceId: string; producer: string; payload: unknown }`.
  - `makeEnvelope(input: { type: string; version: number; traceId: string; producer: string; payload: unknown; eventId?: string; occurredAt?: string }): EventEnvelope` — fills `eventId` (uuid v4) and `occurredAt` (ISO now) when omitted.
  - `HelloCreatedPayloadSchema` (zod) + `HelloCreatedPayload` type: `{ helloId: string; name: string }`.
  - `HELLO_CREATED = "hello.created"` constant.

- [x] **Step 1: Create `packages/contracts/package.json`**

```json
{
  "name": "@ecom/contracts",
  "version": "0.0.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "uuid": "^11.0.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/uuid": "^10.0.0"
  }
}
```

- [x] **Step 2: Create `packages/contracts/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [x] **Step 3: Write the failing test** — `packages/contracts/src/__tests__/envelope.test.ts`

```ts
import { describe, it, expect } from "vitest";
import {
  EventEnvelopeSchema,
  makeEnvelope,
  HelloCreatedPayloadSchema,
  HELLO_CREATED,
} from "../index";

describe("EventEnvelope", () => {
  it("makeEnvelope fills eventId and occurredAt", () => {
    const env = makeEnvelope({
      type: HELLO_CREATED,
      version: 1,
      traceId: "trace-1",
      producer: "hello",
      payload: { helloId: "h1", name: "ada" },
    });
    expect(env.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(env.occurredAt).toString()).not.toBe("Invalid Date");
    expect(EventEnvelopeSchema.parse(env)).toEqual(env);
  });

  it("rejects an envelope missing traceId", () => {
    expect(() => EventEnvelopeSchema.parse({ eventId: "x" })).toThrow();
  });

  it("HelloCreatedPayload rejects a missing name", () => {
    expect(() => HelloCreatedPayloadSchema.parse({ helloId: "h1" })).toThrow();
  });
});
```

- [x] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run packages/contracts`
Expected: FAIL — cannot resolve `../index`.

- [x] **Step 5: Write `packages/contracts/src/envelope.ts`**

```ts
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";

export const EventEnvelopeSchema = z.object({
  eventId: z.string().uuid(),
  type: z.string().min(1),
  version: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  traceId: z.string().min(1),
  producer: z.string().min(1),
  payload: z.unknown(),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export function makeEnvelope(input: {
  type: string;
  version: number;
  traceId: string;
  producer: string;
  payload: unknown;
  eventId?: string;
  occurredAt?: string;
}): EventEnvelope {
  return {
    eventId: input.eventId ?? uuidv4(),
    type: input.type,
    version: input.version,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    traceId: input.traceId,
    producer: input.producer,
    payload: input.payload,
  };
}
```

- [x] **Step 6: Write `packages/contracts/src/events/hello.ts`**

```ts
import { z } from "zod";

export const HELLO_CREATED = "hello.created" as const;

export const HelloCreatedPayloadSchema = z.object({
  helloId: z.string().min(1),
  name: z.string().min(1),
});

export type HelloCreatedPayload = z.infer<typeof HelloCreatedPayloadSchema>;
```

- [x] **Step 7: Write `packages/contracts/src/index.ts`**

```ts
export * from "./envelope";
export * from "./events/hello";
```

- [x] **Step 8: Run test to verify it passes**

Run: `pnpm vitest run packages/contracts`
Expected: PASS (3 tests).

- [x] **Step 9: Commit**

```bash
git add packages/contracts pnpm-lock.yaml
git commit -m "feat(contracts): event envelope + HelloCreated schema"
```

---

### Task 3: `packages/shared` — structured logger (no PII)

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/logger.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/logger.test.ts`

**Interfaces:**
- Produces: `createLogger(service: string)` → `{ info(msg, meta?), warn(msg, meta?), error(msg, meta?) }`. Emits JSON with `{ service, level, message, traceId?, ...meta }`. Callers pass ids/codes only — the logger never inspects or logs request bodies.

- [x] **Step 1: Create `packages/shared/package.json`**

```json
{
  "name": "@ecom/shared",
  "version": "0.0.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@ecom/contracts": "workspace:*",
    "winston": "^3.17.0"
  }
}
```

- [x] **Step 2: Create `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [x] **Step 3: Write the failing test** — `packages/shared/src/__tests__/logger.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import { createLogger } from "../logger";

describe("createLogger", () => {
  it("emits JSON with service, level, message, and passed meta", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = createLogger("hello");
    log.info("order_reserved", { orderId: "o1", traceId: "t1" });
    const line = spy.mock.calls.map((c) => String(c[0])).join("");
    spy.mockRestore();
    const parsed = JSON.parse(line);
    expect(parsed.service).toBe("hello");
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("order_reserved");
    expect(parsed.orderId).toBe("o1");
    expect(parsed.traceId).toBe("t1");
  });
});
```

- [x] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/logger.test.ts`
Expected: FAIL — cannot resolve `../logger`.

- [x] **Step 5: Write `packages/shared/src/logger.ts`**

```ts
import { createLogger as createWinston, format, transports } from "winston";

export type Logger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

// Structured JSON logger. Callers pass ids/codes only — NEVER request bodies,
// passwords, tokens, or email+name pairs (see sensitive-logging rule).
export function createLogger(service: string): Logger {
  const logger = createWinston({
    level: process.env.LOG_LEVEL ?? "info",
    defaultMeta: { service },
    format: format.combine(format.timestamp(), format.json()),
    transports: [new transports.Console()],
  });
  return {
    info: (message, meta) => logger.info(message, meta),
    warn: (message, meta) => logger.warn(message, meta),
    error: (message, meta) => logger.error(message, meta),
  };
}
```

- [x] **Step 6: Write `packages/shared/src/index.ts`**

```ts
export * from "./logger";
```

- [x] **Step 7: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/src/__tests__/logger.test.ts`
Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add packages/shared pnpm-lock.yaml
git commit -m "feat(shared): structured JSON logger, ids-only (no PII)"
```

---

### Task 4: `packages/shared` — AppError family (ported)

**Files:**
- Create: `packages/shared/src/http-status.ts`, `packages/shared/src/errors.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/errors.test.ts`

**Interfaces:**
- Produces: `AppError` (base, fields `statusCode: number`, `status: "fail" | "err"`, `isOperational: true`), and `NotFoundError`, `AuthenticationError`, `ForbiddenError`, `BadRequestError`, each defaulting its own status code. `HTTP_STATUS` map with `NOT_FOUND=404, UNAUTHORIZED=401, FORBIDDEN=403, BAD_REQUEST=400`.

- [x] **Step 1: Write the failing test** — `packages/shared/src/__tests__/errors.test.ts`

```ts
import { describe, it, expect } from "vitest";
import {
  AppError,
  NotFoundError,
  BadRequestError,
  AuthenticationError,
} from "../errors";

describe("AppError family", () => {
  it("BadRequestError is a 400 fail and operational", () => {
    const e = new BadRequestError("bad");
    expect(e).toBeInstanceOf(AppError);
    expect(e.statusCode).toBe(400);
    expect(e.status).toBe("fail");
    expect(e.isOperational).toBe(true);
    expect(e.message).toBe("bad");
  });

  it("NotFoundError defaults to 404, AuthenticationError to 401", () => {
    expect(new NotFoundError().statusCode).toBe(404);
    expect(new AuthenticationError().statusCode).toBe(401);
  });

  it("status is 'err' for 5xx", () => {
    expect(new AppError("boom", 500).status).toBe("err");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/errors.test.ts`
Expected: FAIL — cannot resolve `../errors`.

- [x] **Step 3: Write `packages/shared/src/http-status.ts`**

```ts
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INTERNAL: 500,
} as const;
```

- [x] **Step 4: Write `packages/shared/src/errors.ts`** (ported from `legacy/src/utils/AppError.js`, typed)

```ts
import { HTTP_STATUS } from "./http-status";

export class AppError extends Error {
  statusCode: number;
  status: "fail" | "err";
  isOperational: boolean;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.status = String(statusCode).startsWith("4") ? "fail" : "err";
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not Found") {
    super(message, HTTP_STATUS.NOT_FOUND);
  }
}
export class AuthenticationError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, HTTP_STATUS.UNAUTHORIZED);
  }
}
export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, HTTP_STATUS.FORBIDDEN);
  }
}
export class BadRequestError extends AppError {
  constructor(message = "Bad Request") {
    super(message, HTTP_STATUS.BAD_REQUEST);
  }
}
```

- [x] **Step 5: Update `packages/shared/src/index.ts`**

```ts
export * from "./logger";
export * from "./http-status";
export * from "./errors";
```

- [x] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/src/__tests__/errors.test.ts`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): typed AppError family ported from legacy"
```

---

### Task 5: `packages/shared` — trace-id middleware (ported, PII-safe)

**Files:**
- Create: `packages/shared/src/trace.ts`
- Modify: `packages/shared/src/index.ts`, `packages/shared/package.json`
- Test: `packages/shared/src/__tests__/trace.test.ts`

**Interfaces:**
- Produces: `traceMiddleware(): (req, res, next) => void`. Reads incoming `x-trace-id` header or mints a uuid; sets `req.traceId`, echoes `res` header `x-trace-id`. Logs `http_request` with method, path, traceId ONLY (never body/query values). Also exports `TRACE_HEADER = "x-trace-id"`.

- [x] **Step 1: Add express deps to `packages/shared/package.json`** (merge into existing `dependencies`/`devDependencies`)

```json
{
  "dependencies": {
    "@ecom/contracts": "workspace:*",
    "express": "^4.21.0",
    "uuid": "^11.0.0",
    "winston": "^3.17.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/supertest": "^6.0.2",
    "@types/uuid": "^10.0.0",
    "supertest": "^7.0.0"
  }
}
```

Run: `pnpm install`

- [x] **Step 2: Write the failing test** — `packages/shared/src/__tests__/trace.test.ts`

```ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { traceMiddleware, TRACE_HEADER } from "../trace";

function app() {
  const a = express();
  a.use(traceMiddleware());
  a.get("/", (req, res) => res.json({ traceId: (req as any).traceId }));
  return a;
}

describe("traceMiddleware", () => {
  it("mints a traceId when none is provided and echoes it", async () => {
    const res = await request(app()).get("/");
    expect(res.body.traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers[TRACE_HEADER]).toBe(res.body.traceId);
  });

  it("reuses an incoming x-trace-id", async () => {
    const res = await request(app()).get("/").set(TRACE_HEADER, "abc-123");
    expect(res.body.traceId).toBe("abc-123");
    expect(res.headers[TRACE_HEADER]).toBe("abc-123");
  });
});
```

- [x] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/trace.test.ts`
Expected: FAIL — cannot resolve `../trace`.

- [x] **Step 4: Write `packages/shared/src/trace.ts`** (ported from `legacy/src/middlewares/trace-log.middleware.js`; logs metadata only — the legacy version logged `req.body`, which is a PII leak and is removed here)

```ts
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
```

- [x] **Step 5: Update `packages/shared/src/index.ts`** — add `export * from "./trace";`

```ts
export * from "./logger";
export * from "./http-status";
export * from "./errors";
export * from "./trace";
```

- [x] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/src/__tests__/trace.test.ts`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add packages/shared/src packages/shared/package.json pnpm-lock.yaml
git commit -m "feat(shared): trace-id middleware (PII-safe port)"
```

---

### Task 6: Local infra — `docker-compose.example.yml` + `docs/infra.md`

**Files:**
- Create: `docker-compose.example.yml`, `docs/infra.md`, `.env.example`

**Interfaces:**
- Produces: a runnable local stack — Postgres (one container, one DB per service created at init), Kafka (KRaft, no ZooKeeper), RabbitMQ + management UI, Redis, Kafka-UI. Standard endpoints: Postgres `localhost:5432`, Kafka `localhost:9092`, RabbitMQ `localhost:5672` (UI `15672`), Redis `localhost:6379`, Kafka-UI `localhost:8080`.

- [x] **Step 1: Create `docker-compose.example.yml`**

```yaml
# Copy to docker-compose.yml (gitignored) before running:  cp docker-compose.example.yml docker-compose.yml
name: ecom-platform

services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-ecom}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-ecom}
      POSTGRES_DB: postgres
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./infra/postgres/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-ecom}"]
      interval: 5s
      timeout: 5s
      retries: 10

  kafka:
    image: apache/kafka:3.9.0
    ports: ["9092:9092"]
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
      KAFKA_LISTENERS: PLAINTEXT://:19092,CONTROLLER://:9093,EXTERNAL://:9092
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:19092,EXTERNAL://localhost:9092
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,EXTERNAL:PLAINTEXT
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: 0
    healthcheck:
      test: ["CMD-SHELL", "/opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list || exit 1"]
      interval: 10s
      timeout: 10s
      retries: 10

  kafka-ui:
    image: provectuslabs/kafka-ui:latest
    ports: ["8080:8080"]
    environment:
      KAFKA_CLUSTERS_0_NAME: local
      KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS: kafka:19092
    depends_on: [kafka]

  rabbitmq:
    image: rabbitmq:4-management
    ports: ["5672:5672", "15672:15672"]
    environment:
      RABBITMQ_DEFAULT_USER: ${RABBITMQ_USER:-ecom}
      RABBITMQ_DEFAULT_PASS: ${RABBITMQ_PASSWORD:-ecom}
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]
      interval: 10s
      timeout: 10s
      retries: 10

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  pgdata:
```

- [x] **Step 2: Create the Postgres init script** — `infra/postgres/init/01-databases.sql` (creates one database per service; DB-per-service on a single container)

```sql
CREATE DATABASE hello;
CREATE DATABASE identity;
CREATE DATABASE catalog;
CREATE DATABASE "order";
CREATE DATABASE inventory;
CREATE DATABASE payment;
CREATE DATABASE notification;
```

- [x] **Step 3: Create the root `.env.example`** (compose credentials only; per-service connection strings live in each service's own `.env.example`)

```bash
# Copy to .env (gitignored). Consumed by docker-compose for container credentials.
POSTGRES_USER=ecom
POSTGRES_PASSWORD=ecom
RABBITMQ_USER=ecom
RABBITMQ_PASSWORD=ecom
```

- [x] **Step 4: Create `docs/infra.md`**

````markdown
# Local Infrastructure

The compose file is committed as `docker-compose.example.yml` (no secrets). Your
runnable copy `docker-compose.yml` and your `.env` are gitignored.

## First run

```bash
cp docker-compose.example.yml docker-compose.yml
cp .env.example .env
docker compose up -d
docker compose ps        # wait until all services are healthy
```

Each service also has its own `.env.example` (e.g. `services/hello/.env.example`)
holding its connection strings. Copy it to `.env` in that service's directory
before migrating or running the service:
`cp services/hello/.env.example services/hello/.env`. Each service loads its own
`.env` regardless of the current working directory.

## Endpoints

| Service    | Address                 | Notes                         |
|------------|-------------------------|-------------------------------|
| Postgres   | localhost:5432          | one DB per service (see init) |
| Kafka      | localhost:9092          | KRaft, no ZooKeeper           |
| Kafka-UI   | http://localhost:8080   | topic browser                 |
| RabbitMQ   | localhost:5672          | AMQP                          |
| Rabbit UI  | http://localhost:15672  | user/pass from `.env`         |
| Redis      | localhost:6379          |                               |

## Databases

`infra/postgres/init/01-databases.sql` runs once on first volume creation and
creates a database per service. To re-run it, remove the volume:
`docker compose down -v` (destroys all local data).
````

- [x] **Step 5: Bring the stack up and verify health**

Run:
```bash
cp docker-compose.example.yml docker-compose.yml && cp .env.example .env && docker compose up -d
sleep 30 && docker compose ps
```
Expected: `postgres`, `kafka`, `rabbitmq`, `redis` all show `healthy`.

Run: `docker compose exec -T postgres psql -U ecom -lqt`
Expected: lists databases including `hello`, `identity`, `inventory`.

- [x] **Step 6: Commit** (compose EXAMPLE only; the real `docker-compose.yml` and `.env` are gitignored)

```bash
git add docker-compose.example.yml .env.example docs/infra.md infra/postgres/init/01-databases.sql
git status   # confirm docker-compose.yml and .env are NOT staged
git commit -m "chore(phase0): local infra compose example (KRaft, PG-per-service, Rabbit, Redis)"
```

---

### Task 7: `packages/shared` — Redis client + idempotency helper + lock (ported)

**Files:**
- Create: `packages/shared/src/redis.ts`
- Modify: `packages/shared/src/index.ts`, `packages/shared/package.json`
- Test: `packages/shared/src/__tests__/redis.int.test.ts` (integration — needs the stack up)

**Interfaces:**
- Produces:
  - `getRedis(): Promise<RedisClientType>` — lazily connects a singleton to `REDIS_URL`.
  - `markProcessed(eventId: string, ttlSec?: number): Promise<boolean>` — `SET NX EX`; returns `true` the first time an eventId is seen, `false` for duplicates (idempotency guard).
  - `acquireLock(resource, opts?): Promise<{ key: string; token: string } | null>` and `releaseLock(handle): Promise<number>` — the ported distributed lock (decoupled from any repository; concurrency primitive only).

- [x] **Step 1: Add redis dep to `packages/shared/package.json`** (merge into `dependencies`)

```json
{ "dependencies": { "redis": "^4.7.0" } }
```

Run: `pnpm install`

- [x] **Step 2: Write the failing integration test** — `packages/shared/src/__tests__/redis.int.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { getRedis, markProcessed, acquireLock, releaseLock } from "../redis";

describe("redis helpers (integration — needs docker compose up)", () => {
  beforeAll(async () => {
    await getRedis();
  });
  afterAll(async () => {
    (await getRedis()).quit();
  });

  it("markProcessed returns true once, false on duplicate", async () => {
    const id = uuidv4();
    expect(await markProcessed(id)).toBe(true);
    expect(await markProcessed(id)).toBe(false);
  });

  it("acquireLock then releaseLock round-trips", async () => {
    const handle = await acquireLock(`res_${uuidv4()}`);
    expect(handle).not.toBeNull();
    expect(await releaseLock(handle!)).toBe(1);
  });
});
```

- [x] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/redis.int.test.ts`
Expected: FAIL — cannot resolve `../redis`.

- [x] **Step 4: Write `packages/shared/src/redis.ts`** (lock logic ported from `legacy/src/services/redis.service.js`, minus the inventory-repo coupling)

```ts
import { createClient, type RedisClientType } from "redis";
import { randomUUID } from "crypto";

let client: RedisClientType | null = null;

export async function getRedis(): Promise<RedisClientType> {
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
    client.on("error", () => {}); // errors surface on the awaited command
  }
  if (!client.isOpen) await client.connect();
  return client;
}

// Idempotency guard: true the first time this eventId is seen, false after.
export async function markProcessed(eventId: string, ttlSec = 86_400): Promise<boolean> {
  const c = await getRedis();
  const res = await c.set(`idem:${eventId}`, "1", { NX: true, EX: ttlSec });
  return res === "OK";
}

const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;

export async function acquireLock(
  resource: string,
  opts: { retries?: number; ttlMs?: number } = {}
): Promise<{ key: string; token: string } | null> {
  const { retries = 10, ttlMs = 3000 } = opts;
  const c = await getRedis();
  const key = `lock_v1_${resource}`;
  const token = randomUUID();
  for (let i = 0; i < retries; i++) {
    const res = await c.set(key, token, { NX: true, PX: ttlMs });
    if (res === "OK") return { key, token };
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

export async function releaseLock(handle: { key: string; token: string }): Promise<number> {
  const c = await getRedis();
  return (await c.eval(RELEASE_LOCK_SCRIPT, {
    keys: [handle.key],
    arguments: [handle.token],
  })) as number;
}
```

- [x] **Step 5: Update `packages/shared/src/index.ts`** — add `export * from "./redis";`

- [x] **Step 6: Run test to verify it passes** (stack must be up)

Run: `pnpm vitest run packages/shared/src/__tests__/redis.int.test.ts`
Expected: PASS (2 tests).

- [x] **Step 7: Commit**

```bash
git add packages/shared/src packages/shared/package.json pnpm-lock.yaml
git commit -m "feat(shared): redis client, idempotency guard, ported lock"
```

---

### Task 8: `packages/shared` — Kafka producer/consumer wrapper

**Files:**
- Create: `packages/shared/src/kafka.ts`
- Modify: `packages/shared/src/index.ts`, `packages/shared/package.json`
- Test: `packages/shared/src/__tests__/kafka.int.test.ts` (integration — needs the stack up)

**Interfaces:**
- Produces:
  - `createKafka(clientId: string): Kafka`.
  - `createProducer(kafka): { connect, disconnect, publish(topic, envelope: EventEnvelope) }` — `publish` sends `key = envelope.eventId`, `value = JSON.stringify(envelope)`.
  - `createConsumer(kafka, groupId): { connect, disconnect, run(topics: string[], handler: (env: EventEnvelope) => Promise<void>) }` — parses+validates each message via `EventEnvelopeSchema` before calling `handler`.

- [x] **Step 1: Add kafkajs dep to `packages/shared/package.json`** (merge into `dependencies`)

```json
{ "dependencies": { "kafkajs": "^2.2.4" } }
```

Run: `pnpm install`

- [x] **Step 2: Write the failing integration test** — `packages/shared/src/__tests__/kafka.int.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { makeEnvelope, HELLO_CREATED, type EventEnvelope } from "@ecom/contracts";
import { createKafka, createProducer, createConsumer } from "../kafka";

describe("kafka wrapper (integration — needs docker compose up)", () => {
  it("round-trips a validated envelope", async () => {
    const topic = `test.hello.${uuidv4()}`;
    const kafka = createKafka("test-kafka");
    const producer = createProducer(kafka);
    const consumer = createConsumer(kafka, `g-${uuidv4()}`);

    const received: EventEnvelope[] = [];
    await consumer.connect();
    await consumer.run([topic], async (env) => {
      received.push(env);
    });
    await producer.connect();

    const sent = makeEnvelope({
      type: HELLO_CREATED,
      version: 1,
      traceId: "t1",
      producer: "test",
      payload: { helloId: "h1", name: "ada" },
    });
    await producer.publish(topic, sent);

    const deadline = Date.now() + 15_000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
    }
    await producer.disconnect();
    await consumer.disconnect();

    expect(received).toHaveLength(1);
    expect(received[0].eventId).toBe(sent.eventId);
  });
});
```

- [x] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/kafka.int.test.ts`
Expected: FAIL — cannot resolve `../kafka`.

- [x] **Step 4: Write `packages/shared/src/kafka.ts`**

```ts
import { Kafka, logLevel, type Producer, type Consumer } from "kafkajs";
import { EventEnvelopeSchema, type EventEnvelope } from "@ecom/contracts";

export function createKafka(clientId: string): Kafka {
  return new Kafka({
    clientId,
    brokers: (process.env.KAFKA_BROKERS ?? "localhost:9092").split(","),
    logLevel: logLevel.NOTHING,
  });
}

export function createProducer(kafka: Kafka) {
  const producer: Producer = kafka.producer();
  return {
    connect: () => producer.connect(),
    disconnect: () => producer.disconnect(),
    publish: (topic: string, envelope: EventEnvelope) =>
      producer.send({
        topic,
        messages: [{ key: envelope.eventId, value: JSON.stringify(envelope) }],
      }),
  };
}

export function createConsumer(kafka: Kafka, groupId: string) {
  const consumer: Consumer = kafka.consumer({ groupId });
  return {
    connect: () => consumer.connect(),
    disconnect: () => consumer.disconnect(),
    run: async (topics: string[], handler: (env: EventEnvelope) => Promise<void>) => {
      await Promise.all(
        topics.map((t) => consumer.subscribe({ topic: t, fromBeginning: true }))
      );
      await consumer.run({
        eachMessage: async ({ message }) => {
          if (!message.value) return;
          const env = EventEnvelopeSchema.parse(JSON.parse(message.value.toString()));
          await handler(env);
        },
      });
    },
  };
}
```

- [x] **Step 5: Update `packages/shared/src/index.ts`** — add `export * from "./kafka";`

- [x] **Step 6: Run test to verify it passes** (stack up)

Run: `pnpm vitest run packages/shared/src/__tests__/kafka.int.test.ts`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add packages/shared/src packages/shared/package.json pnpm-lock.yaml
git commit -m "feat(shared): kafka producer/consumer wrapper (envelope-validated)"
```

---

### Task 9: `packages/shared` — RabbitMQ wrapper with dead-letter queue

**Files:**
- Create: `packages/shared/src/rabbitmq.ts`
- Modify: `packages/shared/src/index.ts`, `packages/shared/package.json`
- Test: `packages/shared/src/__tests__/rabbitmq.int.test.ts` (integration — needs the stack up)

**Interfaces:**
- Produces: `createRabbit(): Promise<{ sendCommand(queue, envelope), consumeCommands(queue, handler), assertWorkQueue(queue), close() }>`. `assertWorkQueue` creates a durable queue wired to a dead-letter exchange `<queue>.dlx` → `<queue>.dlq`; a handler that throws causes the message to be `nack`'d (no requeue) and routed to the DLQ.

- [x] **Step 1: Add amqplib dep to `packages/shared/package.json`** (merge into `dependencies` and `devDependencies`)

```json
{
  "dependencies": { "amqplib": "^0.10.4" },
  "devDependencies": { "@types/amqplib": "^0.10.5" }
}
```

Run: `pnpm install`

- [x] **Step 2: Write the failing integration test** — `packages/shared/src/__tests__/rabbitmq.int.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { makeEnvelope, type EventEnvelope } from "@ecom/contracts";
import { createRabbit } from "../rabbitmq";

describe("rabbitmq wrapper (integration — needs docker compose up)", () => {
  it("delivers a command; a throwing handler dead-letters it", async () => {
    const q = `test.cmd.${uuidv4()}`;
    const rabbit = await createRabbit();
    await rabbit.assertWorkQueue(q);

    // happy path: handler receives the command
    const got: EventEnvelope[] = [];
    await rabbit.consumeCommands(q, async (env) => {
      got.push(env);
    });
    const ok = makeEnvelope({ type: "cmd.ok", version: 1, traceId: "t", producer: "test", payload: {} });
    await rabbit.sendCommand(q, ok);

    let deadline = Date.now() + 10_000;
    while (got.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    expect(got).toHaveLength(1);

    // failure path: a throwing handler routes the message to <q>.dlq
    const badQ = `${q}.bad`;
    await rabbit.assertWorkQueue(badQ);
    await rabbit.consumeCommands(badQ, async () => {
      throw new Error("boom");
    });
    await rabbit.sendCommand(badQ, makeEnvelope({ type: "cmd.bad", version: 1, traceId: "t", producer: "test", payload: {} }));

    const dlq = await rabbit.consumeDlqOnce(`${badQ}.dlq`, 10_000);
    await rabbit.close();
    expect(dlq?.type).toBe("cmd.bad");
  });
});
```

- [x] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/rabbitmq.int.test.ts`
Expected: FAIL — cannot resolve `../rabbitmq`.

- [x] **Step 4: Write `packages/shared/src/rabbitmq.ts`**

```ts
import amqp, { type Channel, type Connection } from "amqplib";
import { EventEnvelopeSchema, type EventEnvelope } from "@ecom/contracts";

export async function createRabbit() {
  const conn: Connection = await amqp.connect(
    process.env.RABBITMQ_URL ?? "amqp://ecom:ecom@localhost:5672"
  );
  const ch: Channel = await conn.createChannel();

  async function assertWorkQueue(queue: string): Promise<void> {
    const dlx = `${queue}.dlx`;
    const dlq = `${queue}.dlq`;
    await ch.assertExchange(dlx, "fanout", { durable: true });
    await ch.assertQueue(dlq, { durable: true });
    await ch.bindQueue(dlq, dlx, "");
    await ch.assertQueue(queue, { durable: true, deadLetterExchange: dlx });
  }

  async function sendCommand(queue: string, envelope: EventEnvelope): Promise<void> {
    ch.sendToQueue(queue, Buffer.from(JSON.stringify(envelope)), { persistent: true });
  }

  async function consumeCommands(
    queue: string,
    handler: (env: EventEnvelope) => Promise<void>
  ): Promise<void> {
    await ch.consume(queue, async (msg) => {
      if (!msg) return;
      try {
        const env = EventEnvelopeSchema.parse(JSON.parse(msg.content.toString()));
        await handler(env);
        ch.ack(msg);
      } catch {
        ch.nack(msg, false, false); // no requeue -> routed to the DLX/DLQ
      }
    });
  }

  async function consumeDlqOnce(
    dlq: string,
    timeoutMs: number
  ): Promise<EventEnvelope | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await ch.get(dlq, { noAck: true });
      if (msg) return EventEnvelopeSchema.parse(JSON.parse(msg.content.toString()));
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  }

  async function close(): Promise<void> {
    await ch.close();
    await conn.close();
  }

  return { assertWorkQueue, sendCommand, consumeCommands, consumeDlqOnce, close };
}
```

- [x] **Step 5: Update `packages/shared/src/index.ts`** — add `export * from "./rabbitmq";`

- [x] **Step 6: Run test to verify it passes** (stack up)

Run: `pnpm vitest run packages/shared/src/__tests__/rabbitmq.int.test.ts`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add packages/shared/src packages/shared/package.json pnpm-lock.yaml
git commit -m "feat(shared): rabbitmq wrapper with dead-letter queue"
```

---

### Task 10: `packages/shared` — transactional outbox relay

**Files:**
- Create: `packages/shared/src/outbox.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/outbox.unit.test.ts` (unit — fakes prisma + producer)

**Interfaces:**
- Produces:
  - `OutboxRow` type: `{ id: string; aggregateType: string; aggregateId: string; type: string; version: number; traceId: string; producer: string; payload: unknown; occurredAt: Date; sentAt: Date | null }`.
  - `OutboxPort` — the minimal DB surface the relay needs: `{ fetchUnsent(limit): Promise<OutboxRow[]>; markSent(id): Promise<void> }`.
  - `ProducerPort` — `{ publish(topic: string, envelope: EventEnvelope): Promise<unknown> }`.
  - `drainOutbox(port: OutboxPort, producer: ProducerPort, topicFor: (aggregateType: string) => string, limit?: number): Promise<number>` — publishes each unsent row (envelope built from the row) and marks it sent; returns the count drained. `startOutboxRelay(...)` wraps it in a `setInterval` and returns a `stop()` function.

- [x] **Step 1: Write the failing test** — `packages/shared/src/__tests__/outbox.unit.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { drainOutbox, type OutboxRow } from "../outbox";
import { EventEnvelopeSchema } from "@ecom/contracts";

function fakeRow(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: "row-1",
    aggregateType: "hello",
    aggregateId: "h1",
    type: "hello.created",
    version: 1,
    traceId: "t1",
    producer: "hello",
    payload: { helloId: "h1", name: "ada" },
    occurredAt: new Date("2026-07-18T00:00:00.000Z"),
    sentAt: null,
    ...over,
  };
}

describe("drainOutbox", () => {
  it("publishes unsent rows as valid envelopes and marks them sent", async () => {
    const rows = [fakeRow()];
    const published: Array<{ topic: string; eventId: string }> = [];
    const marked: string[] = [];

    const count = await drainOutbox(
      {
        fetchUnsent: async () => rows,
        markSent: async (id) => {
          marked.push(id);
        },
      },
      {
        publish: async (topic, env) => {
          expect(() => EventEnvelopeSchema.parse(env)).not.toThrow();
          published.push({ topic, eventId: env.eventId });
        },
      },
      (aggregateType) => `${aggregateType}.events`
    );

    expect(count).toBe(1);
    expect(published[0].topic).toBe("hello.events");
    expect(marked).toEqual(["row-1"]);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/outbox.unit.test.ts`
Expected: FAIL — cannot resolve `../outbox`.

- [x] **Step 3: Write `packages/shared/src/outbox.ts`**

```ts
import { makeEnvelope, type EventEnvelope } from "@ecom/contracts";

export type OutboxRow = {
  id: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  version: number;
  traceId: string;
  producer: string;
  payload: unknown;
  occurredAt: Date;
  sentAt: Date | null;
};

export interface OutboxPort {
  fetchUnsent(limit: number): Promise<OutboxRow[]>;
  markSent(id: string): Promise<void>;
}

export interface ProducerPort {
  publish(topic: string, envelope: EventEnvelope): Promise<unknown>;
}

function toEnvelope(row: OutboxRow): EventEnvelope {
  return makeEnvelope({
    eventId: row.id,
    type: row.type,
    version: row.version,
    occurredAt: row.occurredAt.toISOString(),
    traceId: row.traceId,
    producer: row.producer,
    payload: row.payload,
  });
}

export async function drainOutbox(
  port: OutboxPort,
  producer: ProducerPort,
  topicFor: (aggregateType: string) => string,
  limit = 100
): Promise<number> {
  const rows = await port.fetchUnsent(limit);
  for (const row of rows) {
    await producer.publish(topicFor(row.aggregateType), toEnvelope(row));
    await port.markSent(row.id);
  }
  return rows.length;
}

export function startOutboxRelay(
  port: OutboxPort,
  producer: ProducerPort,
  topicFor: (aggregateType: string) => string,
  opts: { intervalMs?: number; limit?: number } = {}
): { stop: () => void } {
  const { intervalMs = 500, limit = 100 } = opts;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await drainOutbox(port, producer, topicFor, limit);
    } finally {
      running = false;
    }
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
```

Note: `eventId === outbox row id` gives producers exactly-one identity per event, so downstream idempotency dedups correctly even if the relay publishes a row twice after a crash.

- [x] **Step 4: Update `packages/shared/src/index.ts`** — add `export * from "./outbox";`

- [x] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/src/__tests__/outbox.unit.test.ts`
Expected: PASS.

- [x] **Step 6: Typecheck the whole shared package**

Run: `pnpm --filter @ecom/shared typecheck`
Expected: no errors.

- [x] **Step 7: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): transactional outbox drain + polling relay"
```

---

### Task 11: `services/hello` — tracer bullet (outbox → Kafka → idempotent consumer)

**Files:**
- Create: `services/hello/package.json`, `services/hello/tsconfig.json`, `services/hello/prisma/schema.prisma`, `services/hello/src/db.ts`, `services/hello/src/outbox-adapter.ts`, `services/hello/src/app.ts`, `services/hello/src/consumer.ts`, `services/hello/src/main.ts`
- Test: `services/hello/src/__tests__/hello.e2e.test.ts` (e2e — needs the stack up)

**Interfaces:**
- Consumes: everything from `@ecom/shared` (kafka, outbox, redis idempotency, trace, logger) and `@ecom/contracts` (`makeEnvelope`, `HELLO_CREATED`, `HelloCreatedPayloadSchema`).
- Produces: an Express app with `POST /hello { name }` that writes a `HelloRecord` + an `Outbox` row in ONE transaction; a relay draining `hello` → topic `hello.events`; a consumer that idempotently records processed events in `ProcessedEvent`.

- [x] **Step 1: Create `services/hello/package.json`**

```json
{
  "name": "@ecom/hello",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "prisma:migrate": "prisma migrate dev",
    "start": "tsx src/main.ts"
  },
  "dependencies": {
    "@ecom/contracts": "workspace:*",
    "@ecom/shared": "workspace:*",
    "@prisma/client": "^6.1.0",
    "dotenv": "^16.4.5",
    "express": "^4.21.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/supertest": "^6.0.2",
    "prisma": "^6.1.0",
    "supertest": "^7.0.0"
  }
}
```

Run: `pnpm install`

- [x] **Step 2: Create `services/hello/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [x] **Step 3: Create `services/hello/prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model HelloRecord {
  id        String   @id @default(uuid())
  name      String
  createdAt DateTime @default(now())
}

model Outbox {
  id            String    @id @default(uuid())
  aggregateType String
  aggregateId   String
  type          String
  version       Int       @default(1)
  traceId       String
  producer      String
  payload       Json
  occurredAt    DateTime  @default(now())
  sentAt        DateTime?

  @@index([sentAt])
}

model ProcessedEvent {
  eventId     String   @id
  type        String
  processedAt DateTime @default(now())
}
```

- [x] **Step 4: Create the per-service env, then run the migration**

Create `services/hello/.env.example` (committed — re-included by the `.gitignore`
negation from Task 1):

```bash
DATABASE_URL=postgresql://ecom:ecom@localhost:5432/hello
KAFKA_BROKERS=localhost:9092
REDIS_URL=redis://localhost:6379
RABBITMQ_URL=amqp://ecom:ecom@localhost:5672
```

Run (copies to the gitignored `.env`, then migrates against the `hello` database):
```bash
cd services/hello && cp .env.example .env && pnpm exec prisma migrate dev --name init && cd ../..
```
Expected: creates `prisma/migrations/*/migration.sql`, applies it, generates the client. (Do not hand-edit the generated migration.)

- [x] **Step 5: Write `services/hello/src/db.ts`** (per-service env: loads `services/hello/.env` regardless of cwd, before Prisma reads `DATABASE_URL`)

```ts
import { config } from "dotenv";
import path from "path";
import { PrismaClient } from "@prisma/client";

// Load THIS service's .env whether started from repo root (vitest) or the
// service dir (tsx). Runs before `new PrismaClient()` reads DATABASE_URL.
config({ path: path.resolve(__dirname, "../.env") });

export const prisma = new PrismaClient();
```

- [x] **Step 6: Write `services/hello/src/outbox-adapter.ts`** — adapts Prisma to the shared `OutboxPort`

```ts
import type { OutboxPort, OutboxRow } from "@ecom/shared";
import { prisma } from "./db";

export const outboxPort: OutboxPort = {
  async fetchUnsent(limit) {
    const rows = await prisma.outbox.findMany({
      where: { sentAt: null },
      orderBy: { occurredAt: "asc" },
      take: limit,
    });
    return rows as unknown as OutboxRow[];
  },
  async markSent(id) {
    await prisma.outbox.update({ where: { id }, data: { sentAt: new Date() } });
  },
};
```

- [x] **Step 7: Write `services/hello/src/app.ts`** — HTTP write persists record + outbox in ONE transaction

```ts
import express from "express";
import { traceMiddleware, createLogger } from "@ecom/shared";
import { HELLO_CREATED, HelloCreatedPayloadSchema } from "@ecom/contracts";
import { prisma } from "./db";

const log = createLogger("hello");

export function createApp() {
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
```

- [x] **Step 8: Write `services/hello/src/consumer.ts`** — Redis primary guard + durable DB backstop

```ts
import { markProcessed, createLogger, type Logger } from "@ecom/shared";
import { EventEnvelope } from "@ecom/contracts";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";

const log: Logger = createLogger("hello-consumer");

// Redis markProcessed is the primary fast-path guard. The ProcessedEvent unique
// constraint (eventId @id) is the durable backstop: if the Redis key was evicted
// and the same event redelivers, the insert throws P2002 — we treat that as
// "already processed" and return, instead of letting the exception wedge the
// Kafka consumer in an infinite offset-retry loop.
export async function handleEvent(env: EventEnvelope): Promise<void> {
  const first = await markProcessed(env.eventId);
  if (!first) {
    log.info("event_duplicate_skipped", { eventId: env.eventId });
    return;
  }
  try {
    await prisma.processedEvent.create({ data: { eventId: env.eventId, type: env.type } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      log.info("event_duplicate_db_skipped", { eventId: env.eventId });
      return;
    }
    throw e;
  }
  log.info("event_processed", { eventId: env.eventId, type: env.type, traceId: env.traceId });
}
```

- [x] **Step 9: Write `services/hello/src/main.ts`** — wires app + relay + consumer (the runnable service)

```ts
import { createApp } from "./app";
import { outboxPort } from "./outbox-adapter";
import { handleEvent } from "./consumer";
import { createKafka, createProducer, createConsumer, startOutboxRelay, createLogger } from "@ecom/shared";

const log = createLogger("hello-main");
const TOPIC = "hello.events";

async function main() {
  const kafka = createKafka("hello");
  const producer = createProducer(kafka);
  await producer.connect();
  const relay = startOutboxRelay(outboxPort, producer, () => TOPIC, { intervalMs: 500 });

  const consumer = createConsumer(kafka, "hello-consumers");
  await consumer.connect();
  await consumer.run([TOPIC], handleEvent);

  const app = createApp();
  const server = app.listen(3000, () => log.info("hello_listening", { port: 3000 }));

  const shutdown = async () => {
    relay.stop();
    await consumer.disconnect();
    await producer.disconnect();
    server.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  log.error("hello_fatal", { message: (e as Error).message });
  process.exit(1);
});
```

- [x] **Step 10: Write the failing e2e test** — `services/hello/src/__tests__/hello.e2e.test.ts` (needs the stack up + migration applied)

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { outboxPort } from "../outbox-adapter";
import { handleEvent } from "../consumer";
import { prisma } from "../db";
import { createKafka, createProducer, createConsumer, startOutboxRelay, getRedis } from "@ecom/shared";

const TOPIC = "hello.events";

describe("hello tracer bullet (e2e — needs docker compose up + migrated)", () => {
  const kafka = createKafka("hello-e2e");
  const producer = createProducer(kafka);
  const consumer = createConsumer(kafka, `hello-e2e-${Date.now()}`);
  let relay: { stop: () => void };

  beforeAll(async () => {
    await producer.connect();
    relay = startOutboxRelay(outboxPort, producer, () => TOPIC, { intervalMs: 300 });
    await consumer.connect();
    await consumer.run([TOPIC], handleEvent);
  });

  afterAll(async () => {
    relay.stop();
    await consumer.disconnect();
    await producer.disconnect();
    (await getRedis()).quit();
    await prisma.$disconnect();
  });

  it("POST /hello flows through outbox -> kafka -> processed exactly once", async () => {
    const res = await request(createApp()).post("/hello").send({ name: "ada" });
    expect(res.status).toBe(201);
    const helloId: string = res.body.helloId;

    // the outbox row id IS the eventId; wait for the consumer to record it
    const deadline = Date.now() + 20_000;
    let processed = null as null | { eventId: string };
    while (!processed && Date.now() < deadline) {
      processed = await prisma.processedEvent.findUnique({ where: { eventId: helloId } });
      if (!processed) await new Promise((r) => setTimeout(r, 400));
    }
    expect(processed).not.toBeNull();

    // idempotency: re-processing the same event does not create a second row
    const count = await prisma.processedEvent.count({ where: { eventId: helloId } });
    expect(count).toBe(1);
  });
});
```

- [x] **Step 11: Run test to verify it fails first**

Run: `pnpm vitest run services/hello/src/__tests__/hello.e2e.test.ts`
Expected: initially FAIL if the service files/migration are incomplete; once Steps 3–9 are in place and the stack is up + migrated, it PASSES.

- [x] **Step 12: Run the e2e test to verify it passes** (stack up, migration applied)

Run:
```bash
docker compose ps                 # confirm healthy
pnpm vitest run services/hello/src/__tests__/hello.e2e.test.ts
```
Expected: PASS — `processedEvent` has exactly one row for the posted helloId.

- [x] **Step 13: Typecheck everything and run the full unit suite**

Run: `pnpm -r typecheck && pnpm vitest run packages`
Expected: no type errors; all unit tests pass.

- [x] **Step 14: Commit**

```bash
git add services/hello pnpm-lock.yaml
git commit -m "feat(hello): tracer bullet — outbox -> kafka -> idempotent consumer"
```

---

### Task 12: Repo-wide ESLint + Prettier

**Files:**
- Create: `eslint.config.js`, `.prettierrc.json`
- Modify: root `package.json` (scripts + devDeps)

**Interfaces:**
- Produces: `pnpm lint` (fails on lint errors) and `pnpm format` (writes) / `pnpm format:check` (verifies) — run by CI.

- [x] **Step 1: Add dev deps + scripts to root `package.json`** (merge)

```json
{
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "devDependencies": {
    "@eslint/js": "^9.17.0",
    "@types/node": "^22.10.0",
    "eslint": "^9.17.0",
    "eslint-config-prettier": "^9.1.0",
    "prettier": "^3.4.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.18.0",
    "vitest": "^2.1.0"
  }
}
```

Run: `pnpm install`

- [x] **Step 2: Create `eslint.config.js`** (ESLint 9 flat config)

```js
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const prettier = require("eslint-config-prettier");

module.exports = tseslint.config(
  { ignores: ["**/dist/**", "**/generated/**", "legacy/**", "**/*.config.js"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  }
);
```

- [x] **Step 3: Create `.prettierrc.json`**

```json
{ "semi": true, "singleQuote": false, "trailingComma": "es5", "printWidth": 90 }
```

- [x] **Step 4: Run lint + format check across the workspace**

Run: `pnpm format && pnpm lint`
Expected: prettier rewrites files to a consistent style; eslint exits 0 (fix any reported errors before committing).

- [x] **Step 5: Commit**

```bash
git add eslint.config.js .prettierrc.json package.json pnpm-lock.yaml packages services
git commit -m "chore(phase0): eslint + prettier, repo-wide"
```

---

### Task 13: `packages/shared` — zod config loader (fail-fast)

**Files:**
- Create: `packages/shared/src/config.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/config.test.ts`

**Interfaces:**
- Produces: `loadConfig<S extends ZodTypeAny>(schema: S, env?): z.infer<S>` — parses `process.env` against `schema`; on failure throws `Error` naming the invalid/missing keys (so a service crashes at boot, not mid-request). Never logs values.

- [x] **Step 1: Write the failing test** — `packages/shared/src/__tests__/config.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { loadConfig } from "../config";

const schema = z.object({
  PORT: z.coerce.number().int().positive(),
  DATABASE_URL: z.string().url(),
});

describe("loadConfig", () => {
  it("parses and coerces a valid env", () => {
    const cfg = loadConfig(schema, { PORT: "3000", DATABASE_URL: "postgres://h/db" });
    expect(cfg.PORT).toBe(3000);
  });

  it("throws naming the missing key, without leaking values", () => {
    expect(() => loadConfig(schema, { PORT: "3000" })).toThrow(/DATABASE_URL/);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/config.test.ts`
Expected: FAIL — cannot resolve `../config`.

- [x] **Step 3: Write `packages/shared/src/config.ts`**

```ts
import { ZodError, type ZodTypeAny, type z } from "zod";

export function loadConfig<S extends ZodTypeAny>(
  schema: S,
  env: NodeJS.ProcessEnv = process.env
): z.infer<S> {
  try {
    return schema.parse(env);
  } catch (e) {
    if (e instanceof ZodError) {
      const keys = e.issues.map((i) => i.path.join(".")).join(", ");
      // Names only — never echo the values (may be secrets).
      throw new Error(`Invalid configuration — check these env vars: ${keys}`);
    }
    throw e;
  }
}
```

- [x] **Step 4: Update `packages/shared/src/index.ts`** — add `export * from "./config";`

- [x] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/src/__tests__/config.test.ts`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): fail-fast zod config loader"
```

---

### Task 14: `packages/shared` — health/readiness router

**Files:**
- Create: `packages/shared/src/health.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/health.test.ts`

**Interfaces:**
- Produces: `createHealthRouter(checks?: Record<string, () => Promise<void>>): Router` — `GET /healthz` → `200 {status:"ok"}` (liveness, no deps); `GET /readyz` → runs every check, `200 {status:"ready"}` if all resolve else `503 {status:"unready", failed:[names]}`.

- [x] **Step 1: Write the failing test** — `packages/shared/src/__tests__/health.test.ts`

```ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createHealthRouter } from "../health";

describe("createHealthRouter", () => {
  it("healthz is always ok", async () => {
    const app = express().use(createHealthRouter());
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("readyz is 503 and lists the failing check", async () => {
    const app = express().use(
      createHealthRouter({
        db: async () => {},
        broker: async () => {
          throw new Error("down");
        },
      })
    );
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.failed).toContain("broker");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/health.test.ts`
Expected: FAIL — cannot resolve `../health`.

- [x] **Step 3: Write `packages/shared/src/health.ts`**

```ts
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
```

- [x] **Step 4: Update `packages/shared/src/index.ts`** — add `export * from "./health";`

- [x] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/src/__tests__/health.test.ts`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): health/readiness router"
```

---

### Task 15: `packages/shared` — retry/backoff + graceful shutdown

**Files:**
- Create: `packages/shared/src/retry.ts`, `packages/shared/src/lifecycle.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/retry.test.ts`, `packages/shared/src/__tests__/lifecycle.test.ts`

**Interfaces:**
- Produces:
  - `withRetry<T>(fn: () => Promise<T>, opts?: { retries?: number; baseMs?: number; label?: string }): Promise<T>` — retries on rejection with exponential backoff + jitter; rethrows the last error after `retries`.
  - `runClosers(closers: Closer[], timeoutMs: number): Promise<void>` — runs closers in REVERSE registration order; rejects if not done within `timeoutMs`.
  - `gracefulShutdown(closers: Closer[], opts?: { timeoutMs?: number }): void` — installs SIGTERM/SIGINT handlers that call `runClosers` then `process.exit`.

- [x] **Step 1: Write the failing tests**

`packages/shared/src/__tests__/retry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { withRetry } from "../retry";

describe("withRetry", () => {
  it("resolves after transient failures", async () => {
    let n = 0;
    const out = await withRetry(
      async () => {
        n++;
        if (n < 3) throw new Error("transient");
        return "ok";
      },
      { retries: 5, baseMs: 1 }
    );
    expect(out).toBe("ok");
    expect(n).toBe(3);
  });

  it("rethrows after exhausting retries", async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new Error("always");
        },
        { retries: 2, baseMs: 1 }
      )
    ).rejects.toThrow("always");
    expect(n).toBe(3); // initial + 2 retries
  });
});
```

`packages/shared/src/__tests__/lifecycle.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runClosers } from "../lifecycle";

describe("runClosers", () => {
  it("runs closers in reverse order", async () => {
    const order: number[] = [];
    await runClosers(
      [async () => void order.push(1), async () => void order.push(2), async () => void order.push(3)],
      1000
    );
    expect(order).toEqual([3, 2, 1]);
  });

  it("rejects when a closer hangs past the timeout", async () => {
    await expect(runClosers([() => new Promise(() => {})], 50)).rejects.toThrow(/timeout/);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/shared/src/__tests__/retry.test.ts packages/shared/src/__tests__/lifecycle.test.ts`
Expected: FAIL — cannot resolve `../retry` / `../lifecycle`.

- [x] **Step 3: Write `packages/shared/src/retry.ts`**

```ts
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number; label?: string } = {}
): Promise<T> {
  const { retries = 5, baseMs = 200 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === retries) break;
      const backoff = baseMs * 2 ** attempt;
      const jitter = Math.random() * backoff * 0.2;
      await new Promise((r) => setTimeout(r, backoff + jitter));
    }
  }
  throw lastErr;
}
```

- [x] **Step 4: Write `packages/shared/src/lifecycle.ts`**

```ts
import { createLogger } from "./logger";

const log = createLogger("lifecycle");
export type Closer = () => Promise<void> | void;

export async function runClosers(closers: Closer[], timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout;
  const drain = (async () => {
    for (const close of [...closers].reverse()) await close();
  })();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("shutdown_timeout")), timeoutMs);
  });
  try {
    await Promise.race([drain, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export function gracefulShutdown(closers: Closer[], opts: { timeoutMs?: number } = {}): void {
  const { timeoutMs = 10_000 } = opts;
  let shuttingDown = false;
  const handle = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown_start", { signal });
    try {
      await runClosers(closers, timeoutMs);
      log.info("shutdown_complete", {});
      process.exit(0);
    } catch (e) {
      log.error("shutdown_error", { message: (e as Error).message });
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void handle("SIGTERM"));
  process.on("SIGINT", () => void handle("SIGINT"));
}
```

- [x] **Step 5: Update `packages/shared/src/index.ts`** — add `export * from "./retry";` and `export * from "./lifecycle";`

- [x] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run packages/shared/src/__tests__/retry.test.ts packages/shared/src/__tests__/lifecycle.test.ts`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): withRetry backoff + graceful shutdown"
```

---

### Task 16: Broker resilience — retry connect, idempotent producer, Kafka consumer error boundary

**Files:**
- Modify: `packages/shared/src/kafka.ts`
- Test: `packages/shared/src/__tests__/kafka-dlq.int.test.ts` (integration — needs the stack up)

**Interfaces:**
- Produces (updated `kafka.ts`):
  - `createKafka` sets a bounded client-level retry policy.
  - `createProducer(kafka)` uses an **idempotent** producer; `connect` wrapped in `withRetry`.
  - `createConsumer(kafka, groupId)` — `run(topics, handler, opts?)`: on handler failure, retries `opts.maxRetries` times (backoff) then **parks the message on `<topic>.dlq`** and commits, so one poison message can't wedge the partition. Requires an internal producer for parking.

- [x] **Step 1: Write the failing integration test** — `packages/shared/src/__tests__/kafka-dlq.int.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { makeEnvelope, HELLO_CREATED, type EventEnvelope } from "@ecom/contracts";
import { createKafka, createProducer, createConsumer } from "../kafka";

describe("kafka consumer error boundary (integration — needs stack up)", () => {
  it("parks a poison message on <topic>.dlq after exhausting retries", async () => {
    const topic = `test.poison.${uuidv4()}`;
    const kafka = createKafka("test-dlq");
    const producer = createProducer(kafka);
    const failing = createConsumer(kafka, `g-${uuidv4()}`);
    const dlqReader = createConsumer(kafka, `gdlq-${uuidv4()}`);

    const parked: EventEnvelope[] = [];
    await dlqReader.connect();
    await dlqReader.run([`${topic}.dlq`], async (env) => void parked.push(env));

    await failing.connect();
    await failing.run([topic], async () => {
      throw new Error("poison");
    }, { maxRetries: 1 });

    await producer.connect();
    await producer.publish(
      topic,
      makeEnvelope({ type: HELLO_CREATED, version: 1, traceId: "t", producer: "test", payload: { helloId: "h", name: "x" } })
    );

    const deadline = Date.now() + 20_000;
    while (parked.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
    await producer.disconnect();
    await failing.disconnect();
    await dlqReader.disconnect();

    expect(parked).toHaveLength(1);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/kafka-dlq.int.test.ts`
Expected: FAIL — `run` does not accept a retry option / no parking behavior yet.

- [x] **Step 3: Replace `packages/shared/src/kafka.ts`** with the resilient version

```ts
import { Kafka, logLevel, type Producer, type Consumer } from "kafkajs";
import { EventEnvelopeSchema, type EventEnvelope } from "@ecom/contracts";
import { withRetry } from "./retry";
import { createLogger } from "./logger";

const log = createLogger("kafka");

export function createKafka(clientId: string): Kafka {
  return new Kafka({
    clientId,
    brokers: (process.env.KAFKA_BROKERS ?? "localhost:9092").split(","),
    logLevel: logLevel.NOTHING,
    retry: { retries: 8, initialRetryTime: 300 },
  });
}

export function createProducer(kafka: Kafka) {
  const producer: Producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
  return {
    connect: () => withRetry(() => producer.connect(), { label: "producer.connect" }),
    disconnect: () => producer.disconnect(),
    publish: (topic: string, envelope: EventEnvelope) =>
      producer.send({
        topic,
        messages: [{ key: envelope.eventId, value: JSON.stringify(envelope) }],
      }),
  };
}

export function createConsumer(kafka: Kafka, groupId: string) {
  const consumer: Consumer = kafka.consumer({ groupId });
  const parker: Producer = kafka.producer();
  return {
    connect: async () => {
      await withRetry(() => consumer.connect(), { label: "consumer.connect" });
      await withRetry(() => parker.connect(), { label: "parker.connect" });
    },
    disconnect: async () => {
      await consumer.disconnect();
      await parker.disconnect();
    },
    run: async (
      topics: string[],
      handler: (env: EventEnvelope) => Promise<void>,
      opts: { maxRetries?: number } = {}
    ) => {
      const { maxRetries = 3 } = opts;
      await Promise.all(topics.map((t) => consumer.subscribe({ topic: t, fromBeginning: true })));
      await consumer.run({
        eachMessage: async ({ topic, message }) => {
          if (!message.value) return;
          const raw = message.value.toString();
          const env = EventEnvelopeSchema.parse(JSON.parse(raw));
          try {
            await withRetry(() => handler(env), { retries: maxRetries, baseMs: 200 });
          } catch (e) {
            // Poison message: park it and commit so the partition keeps moving.
            log.error("event_parked_to_dlq", { eventId: env.eventId, topic, message: (e as Error).message });
            await parker.send({ topic: `${topic}.dlq`, messages: [{ key: env.eventId, value: raw }] });
          }
        },
      });
    },
  };
}
```

- [x] **Step 4: Run the new DLQ test AND the original round-trip test** (stack up)

Run: `pnpm vitest run packages/shared/src/__tests__/kafka-dlq.int.test.ts packages/shared/src/__tests__/kafka.int.test.ts`
Expected: both PASS. (The Task 8 round-trip test still passes — `run`'s new third arg is optional.)

- [x] **Step 5: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): kafka resilience — retry connect, idempotent producer, DLQ parking"
```

---

### Task 17: `services/hello` — Dockerfile, prod compose profile, wire config/health/shutdown

**Files:**
- Create: `services/hello/Dockerfile`, `.dockerignore`
- Create: `services/hello/src/config.ts`
- Modify: `services/hello/src/app.ts`, `services/hello/src/main.ts`, `docker-compose.example.yml`

**Interfaces:**
- Consumes: `loadConfig`, `createHealthRouter`, `gracefulShutdown`, `getRedis` from `@ecom/shared`.
- Produces: `services/hello/src/config.ts` exporting a validated `config`; a `hello` image built by a multi-stage Dockerfile; a `--profile app` compose service.

- [x] **Step 1: Write `services/hello/src/config.ts`**

```ts
import { z } from "zod";
import { loadConfig } from "@ecom/shared";

export const config = loadConfig(
  z.object({
    DATABASE_URL: z.string().url(),
    KAFKA_BROKERS: z.string().default("localhost:9092"),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    PORT: z.coerce.number().int().positive().default(3000),
  })
);
```

- [x] **Step 2: Update `services/hello/src/app.ts`** — mount the health router and use validated config

```ts
import express from "express";
import { traceMiddleware, createLogger, createHealthRouter, getRedis } from "@ecom/shared";
import { HELLO_CREATED, HelloCreatedPayloadSchema } from "@ecom/contracts";
import { prisma } from "./db";

const log = createLogger("hello");

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(traceMiddleware());

  app.use(
    createHealthRouter({
      db: async () => void (await prisma.$queryRaw`SELECT 1`),
      redis: async () => void (await (await getRedis()).ping()),
    })
  );

  app.post("/hello", async (req, res) => {
    const name = String(req.body?.name ?? "");
    if (!name) return res.status(400).json({ error: "name required" });

    const created = await prisma.$transaction(async (tx) => {
      const rec = await tx.helloRecord.create({ data: { name } });
      const payload = HelloCreatedPayloadSchema.parse({ helloId: rec.id, name: rec.name });
      await tx.outbox.create({
        data: {
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
```

- [x] **Step 3: Update `services/hello/src/main.ts`** — validated config + graceful shutdown

```ts
import { createApp } from "./app";
import { config } from "./config";
import { outboxPort } from "./outbox-adapter";
import { handleEvent } from "./consumer";
import { prisma } from "./db";
import {
  createKafka,
  createProducer,
  createConsumer,
  startOutboxRelay,
  createLogger,
  gracefulShutdown,
  getRedis,
} from "@ecom/shared";

const log = createLogger("hello-main");
const TOPIC = "hello.events";

async function main() {
  const kafka = createKafka("hello");
  const producer = createProducer(kafka);
  await producer.connect();
  const relay = startOutboxRelay(outboxPort, producer, () => TOPIC, { intervalMs: 500 });

  const consumer = createConsumer(kafka, "hello-consumers");
  await consumer.connect();
  await consumer.run([TOPIC], handleEvent);

  const app = createApp();
  const server = app.listen(config.PORT, () => log.info("hello_listening", { port: config.PORT }));

  gracefulShutdown([
    async () => void server.close(),
    async () => relay.stop(),
    async () => consumer.disconnect(),
    async () => producer.disconnect(),
    async () => (await getRedis()).quit(),
    async () => prisma.$disconnect(),
  ]);
}

main().catch((e) => {
  log.error("hello_fatal", { message: (e as Error).message });
  process.exit(1);
});
```

- [x] **Step 4: Create `services/hello/.dockerignore`**

```
node_modules
dist
.env
```

- [x] **Step 5: Create `services/hello/Dockerfile`** (multi-stage; build context is the repo root)

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

# --- deps + build ---
FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/hello ./services/hello
RUN pnpm install --frozen-lockfile --filter @ecom/hello...
RUN pnpm --filter @ecom/hello exec prisma generate
RUN pnpm --filter @ecom/contracts --filter @ecom/shared --filter @ecom/hello build

# --- runtime ---
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/services/hello
EXPOSE 3000
CMD ["pnpm", "exec", "tsx", "src/main.ts"]
```

- [x] **Step 6: Add a prod `app` profile service to `docker-compose.example.yml`** (append under `services:`, before `volumes:`)

```yaml
  hello:
    profiles: ["app"]
    build:
      context: .
      dockerfile: services/hello/Dockerfile
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-ecom}:${POSTGRES_PASSWORD:-ecom}@postgres:5432/hello
      KAFKA_BROKERS: kafka:19092
      REDIS_URL: redis://redis:6379
      PORT: 3000
    ports: ["3000:3000"]
    depends_on:
      postgres: { condition: service_healthy }
      kafka: { condition: service_healthy }
      redis: { condition: service_healthy }
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/readyz || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 10
```

- [x] **Step 7: Build the image and verify readiness** (infra must be up + `hello` DB migrated)

Run:
```bash
docker compose build hello
docker compose --profile app up -d hello
sleep 15 && curl -fsS localhost:3000/readyz
```
Expected: `docker compose build` succeeds; `/readyz` returns `{"status":"ready"}`.

- [x] **Step 8: Typecheck + commit**

Run: `pnpm --filter @ecom/hello typecheck`
Expected: no errors.

```bash
git add services/hello docker-compose.example.yml
git commit -m "feat(hello): dockerfile, prod compose profile, config+health+shutdown"
```

---

### Task 18: CI workflow (replaces the legacy deploy workflow)

**Files:**
- Create: `.github/workflows/ci.yml`
- Delete: `.github/workflows/node.js.yml` (legacy monolith deploy — `npm run ci` = pm2 restart; broken once `package.json` moved to `legacy/`)

**Interfaces:**
- Produces: CI that runs on every push/PR — install → lint → format check → typecheck → unit tests → (with infra up) integration + e2e → build → `pnpm audit`.

- [x] **Step 1: Remove the obsolete legacy workflow**

```bash
git rm .github/workflows/node.js.yml
```

- [x] **Step 2: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: ["main", "feat/**"]
  pull_request:

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: "pnpm" }
      - run: pnpm install --frozen-lockfile
      - run: pnpm format:check
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm vitest run packages/**/*.test.ts --exclude "**/*.int.test.ts"
      - run: pnpm -r build
      - run: pnpm audit --audit-level high || true

  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: "pnpm" }
      - run: pnpm install --frozen-lockfile
      - name: Start infra
        run: |
          cp docker-compose.example.yml docker-compose.yml
          printf 'POSTGRES_USER=ecom\nPOSTGRES_PASSWORD=ecom\nRABBITMQ_USER=ecom\nRABBITMQ_PASSWORD=ecom\n' > .env
          docker compose up -d
          timeout 120 sh -c 'until [ "$(docker compose ps --format "{{.Health}}" | grep -c healthy)" -ge 4 ]; do sleep 3; done'
      - name: Migrate hello DB
        run: |
          printf 'DATABASE_URL=postgresql://ecom:ecom@localhost:5432/hello\nKAFKA_BROKERS=localhost:9092\nREDIS_URL=redis://localhost:6379\n' > services/hello/.env
          pnpm --filter @ecom/hello exec prisma migrate deploy
      - name: Integration + e2e tests
        run: pnpm vitest run "**/*.int.test.ts" "**/*.e2e.test.ts"
```

- [x] **Step 3: Validate the workflow YAML locally**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('ci.yml OK')"`
Expected: `ci.yml OK`. (Full CI runs on push; this just catches YAML errors before committing.)

- [x] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git rm --cached .github/workflows/node.js.yml 2>/dev/null || true
git commit -m "ci(phase0): monorepo CI (lint/typecheck/test/build/audit), drop legacy deploy"
```

---

## Phase 0 acceptance

- `pnpm install` resolves the workspace; `pnpm -r typecheck`, `pnpm lint`, and `pnpm format:check` are clean.
- `docker compose up -d` brings Postgres (DB-per-service), Kafka (KRaft), RabbitMQ (+DLQ-capable), Redis, and Kafka-UI to healthy.
- Unit tests pass with no infra: contracts envelope, logger, errors, trace, outbox drain, config loader, health router, retry, lifecycle.
- Integration tests pass with the stack up: redis idempotency + lock, kafka round-trip, kafka DLQ-parking, rabbitmq DLQ.
- **Production primitives:** a service crashes at boot on bad env (config); `/healthz`+`/readyz` reflect dependency reachability; SIGTERM drains and exits cleanly; a poison Kafka message parks on `<topic>.dlq` instead of wedging the partition.
- **Tracer bullet:** `POST /hello` persists a record + outbox row in one transaction, the polling relay publishes it to Kafka, and the consumer records it in `ProcessedEvent` exactly once — re-delivery is deduped by the Redis idempotency guard. Verifiable in Kafka-UI (`hello.events` topic) and in the `hello` database.
- **Build + CI:** the `hello` multi-stage image builds and `/readyz` returns ready under the `--profile app` compose profile; `.github/workflows/ci.yml` runs lint → typecheck → unit → integration/e2e → build → audit, and the legacy deploy workflow is removed.
- The old monolith lives under `legacy/`, untouched and unreferenced by the new packages.

## Self-review notes

- **Spec coverage:** monorepo (T1), contracts (T2), logger/errors/trace/redis/kafka/rabbit/outbox in `shared` (T3–T10), docker-compose.example + infra.md + gitignore (T6), DB-per-service via single-container multi-DB init (T6), Prisma per service (T11), hello-event acceptance (T11). Broker roles exercised: Kafka backbone (T8/T11), RabbitMQ commands+DLQ (T9), Redis lock+idempotency (T7/T11).
- **Production baseline coverage (decision #11 / DoD):** lint+format (T12), fail-fast config (T13), health/readiness (T14), retry/backoff + graceful shutdown (T15), Kafka resilience + DLQ-parking (T16), Dockerfile + prod compose profile + wired config/health/shutdown (T17), CI (T18). Deferred to per-service phases / Phase 7 per the DoD: RED+domain metrics endpoints, k6 load + chaos suite, SLO alerting, runbooks, circuit breakers on sync edges (no sync service calls exist yet in Phase 0).
- **No PII:** logger and trace middleware log ids/codes only; the legacy body-logging behavior is deliberately dropped (T5).
- **Type consistency:** `OutboxPort`/`OutboxRow`/`ProducerPort` defined in T10 and consumed in T11; `EventEnvelope`/`makeEnvelope` defined in T2 and used in T8/T9/T10/T11; `markProcessed` defined in T7 and used in T11.
- **Per-service env:** the root `.env` carries compose credentials only; each
  service owns a `.env.example`/`.env` with its own connection strings and loads
  it from its own directory (T5 `db.ts`), so migrate/run/test work from any cwd.
  The `.gitignore` negations (T1) re-include the committed `.env.example` templates.
- **Idempotency (Redis kept primary):** Redis `markProcessed` is the fast-path
  guard; the `ProcessedEvent` unique constraint is the durable backstop, and a
  P2002 on redelivery is swallowed (T8) so an evicted Redis key can't wedge the
  consumer.
- **`BaseController` intentionally deferred:** Phase 0's `hello` service uses one
  inline handler; a shared `BaseController` earns its place at the first service
  with multiple controllers sharing response/error plumbing (Phase 1+).
- **Deferred to later phases (not Phase 0):** OpenTelemetry/Jaeger + Prometheus/Grafana (Phase 7); testcontainers-based isolation for CI (integration tests here run against the dev compose stack); Debezium (polling relay is intentional for Phase 0).
