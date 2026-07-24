import { PAYMENT_SUCCEEDED, PAYMENT_FAILED, PAYMENT_REFUNDED } from "@ecom/contracts";

export interface ResolveTx {
  loadPayment(
    orderId: string
  ): Promise<{ paymentId: string; status: string; amount: number } | null>;
  // Conditional status write; returns rows changed (1 = we won, 0 = someone else did).
  casStatus(orderId: string, from: string, to: string): Promise<number>;
  createAttempt(paymentId: string, outcome: string): Promise<void>;
  enqueue(type: string, orderId: string, payload: unknown): Promise<void>;
}

// Inbound webhook resolves a PROCESSING payment. Compare-and-set guards concurrent
// webhooks: only the caller that flips PROCESSING->outcome (count 1) emits.
export async function finalizePayment(
  tx: ResolveTx,
  p: { orderId: string; outcome: "SUCCEEDED" | "FAILED" }
): Promise<"FINALIZED" | "NOOP" | "NOT_FOUND"> {
  const payment = await tx.loadPayment(p.orderId);
  if (payment === null) return "NOT_FOUND";

  const won = await tx.casStatus(p.orderId, "PROCESSING", p.outcome);
  if (won === 0) return "NOOP"; // already finalized, or was never PROCESSING

  await tx.createAttempt(payment.paymentId, p.outcome);
  if (p.outcome === "SUCCEEDED") {
    await tx.enqueue(PAYMENT_SUCCEEDED, p.orderId, {
      orderId: p.orderId,
      paymentId: payment.paymentId,
      amount: payment.amount,
    });
  } else {
    await tx.enqueue(PAYMENT_FAILED, p.orderId, {
      orderId: p.orderId,
      reason: "WEBHOOK_DECLINED",
    });
  }
  return "FINALIZED";
}

// Admin refund stub — reused Task 4. Kept here so webhook + refund share ResolveTx.
export async function refundPayment(
  tx: ResolveTx,
  p: { orderId: string }
): Promise<"REFUNDED" | "NOOP" | "NOT_FOUND" | "NOT_REFUNDABLE"> {
  const payment = await tx.loadPayment(p.orderId);
  if (payment === null) return "NOT_FOUND";
  if (payment.status === "REFUNDED") return "NOOP";
  if (payment.status !== "SUCCEEDED") return "NOT_REFUNDABLE";

  const won = await tx.casStatus(p.orderId, "SUCCEEDED", "REFUNDED");
  if (won === 0) return "NOOP"; // concurrent refund already won

  await tx.createAttempt(payment.paymentId, "REFUNDED");
  await tx.enqueue(PAYMENT_REFUNDED, p.orderId, {
    orderId: p.orderId,
    paymentId: payment.paymentId,
    amount: payment.amount,
  });
  return "REFUNDED";
}
