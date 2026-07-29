import { Counter, type Registry } from "prom-client";

export type PaymentOutcome = "succeeded" | "failed" | "processing";

export function createPaymentMetrics(registry: Registry) {
  const attempts = new Counter({
    name: "payment_attempts_total",
    help: "Payment charge attempts by outcome",
    labelNames: ["outcome"],
    registers: [registry],
  });
  return { observe: (outcome: PaymentOutcome) => attempts.inc({ outcome }) };
}

export type PaymentMetrics = ReturnType<typeof createPaymentMetrics>;
