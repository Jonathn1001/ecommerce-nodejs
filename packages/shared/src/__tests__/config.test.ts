import { describe, it, expect } from "vitest";
import { z } from "zod";
import { loadConfig } from "../config";

const schema = z.object({
  PORT: z.coerce.number().int().positive(),
  DATABASE_URL: z.string().url(),
});

describe("loadConfig", () => {
  it("parses and coerces a valid env", () => {
    const cfg = loadConfig(schema, {
      PORT: "3000",
      DATABASE_URL: "postgres://h/db",
    });
    expect(cfg.PORT).toBe(3000);
  });

  it("throws naming the missing key, without leaking values", () => {
    expect(() => loadConfig(schema, { PORT: "3000" })).toThrow(/DATABASE_URL/);
  });
});
