import { Counter, type Registry } from "prom-client";

export type ReservationOutcome = "RESERVED" | "FAILED" | "DUPLICATE";

export function createReservationMetrics(registry: Registry) {
  const outcomes = new Counter({
    name: "reservation_outcomes_total",
    help: "Inventory reservation attempts by outcome",
    labelNames: ["outcome"],
    registers: [registry],
  });
  return { observe: (outcome: ReservationOutcome) => outcomes.inc({ outcome }) };
}

export type ReservationMetrics = ReturnType<typeof createReservationMetrics>;
