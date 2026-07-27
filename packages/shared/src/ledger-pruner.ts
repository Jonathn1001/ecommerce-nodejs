import { createLogger } from "./logger";

const log = createLogger("ledger-pruner");

export interface LedgerPrunerPort {
  // Deletes ledger rows processed before `cutoff`; returns how many went.
  deleteOlderThan(cutoff: Date): Promise<number>;
}

// The dedup ledger only has to outlive the longest possible redelivery, which Kafka's own
// retention bounds — so anything past the window is dead weight. Same shape as
// startExpirySweeper: an interval over a port, unref'd so it never holds the process open.
export function startLedgerPruner(
  port: LedgerPrunerPort,
  opts: { retentionDays?: number; intervalMs?: number } = {}
): { stop: () => void } {
  const { retentionDays = 30, intervalMs = 3_600_000 } = opts;
  let running = false;

  const timer = setInterval(() => {
    if (running) return; // never overlap a slow prune with the next tick
    running = true;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 3600_000);
    // Call the port from inside the `.then`, not directly: a port that throws
    // synchronously (rather than rejecting) would otherwise throw before any
    // `.then/.catch/.finally` chain exists to catch it, leaving `running` stuck
    // true forever and silently stopping all future pruning.
    Promise.resolve()
      .then(() => port.deleteOlderThan(cutoff))
      .then((count) => {
        if (count > 0) log.info("ledger_pruned", { count, retentionDays });
      })
      .catch((e) => log.error("ledger_prune_failed", { message: (e as Error).message }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
  };
}
