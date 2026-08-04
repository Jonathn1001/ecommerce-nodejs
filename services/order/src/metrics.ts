import { Histogram, type Registry } from "prom-client";

// Straddles the roadmap's saga p99 < 5s SLO.
// 7d reproduced by hand, to four decimals from raw bucket counts, that the 1 → 2.5 gap
// overestimates saga p99 in exactly the range the saga lands in. 1.5 and 2 close it; the <5s
// SLO is unaffected either way.
const SAGA_BUCKETS = [0.1, 0.25, 0.5, 1, 1.5, 2, 2.5, 5, 10, 30];

export function createSagaMetrics(registry: Registry) {
  const stepDuration = new Histogram({
    name: "saga_step_duration_seconds",
    help: "Duration of one checkout saga step",
    labelNames: ["step"],
    buckets: SAGA_BUCKETS,
    registers: [registry],
  });
  const sagaDuration = new Histogram({
    name: "saga_duration_seconds",
    help: "Duration of a checkout saga from order creation to a terminal status",
    labelNames: ["outcome"],
    buckets: SAGA_BUCKETS,
    registers: [registry],
  });

  return {
    observeStep: (step: "reserve" | "payment", seconds: number) =>
      stepDuration.observe({ step }, seconds),
    observeSaga: (outcome: "confirmed" | "cancelled", seconds: number) =>
      sagaDuration.observe({ outcome }, seconds),
  };
}

export type SagaMetrics = ReturnType<typeof createSagaMetrics>;
