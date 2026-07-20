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

export function gracefulShutdown(
  closers: Closer[],
  opts: { timeoutMs?: number } = {}
): void {
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
