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
