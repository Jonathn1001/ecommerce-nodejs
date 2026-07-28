import { CHARGE_PAYMENT, PAYMENT_SUCCEEDED, PAYMENT_FAILED } from "@ecom/contracts";

// Deterministic simulated gateway (no real money). Magic minor-units totals:
//   %100==1  -> FAILED (declined)
//   %100==99 -> PROCESSING (async — resolved later by POST /webhooks/payment)
//   else     -> SUCCEEDED
export function simulateCharge(amount: number): "SUCCEEDED" | "FAILED" | "PROCESSING" {
  if (amount % 100 === 1) return "FAILED";
  if (amount % 100 === 99) return "PROCESSING";
  return "SUCCEEDED";
}

export interface ChargeTx {
  markProcessed(eventId: string, type: string): Promise<boolean>; // false => already processed
  paymentExists(orderId: string): Promise<boolean>;
  // userId is nullable: a legacy ChargePayment (minted before this contract widened) carries none.
  createPayment(
    orderId: string,
    amount: number,
    status: string,
    userId: string | null
  ): Promise<string>; // returns paymentId
  createAttempt(paymentId: string, outcome: string): Promise<void>;
  enqueue(type: string, orderId: string, payload: unknown): Promise<void>;
}

export type ChargeOutcome =
  "DUPLICATE" | "ALREADY_CHARGED" | "SUCCEEDED" | "FAILED" | "PROCESSING";

// Domain core over a tx-bound port (mirrors inventory/reserve.ts). markProcessed
// first (the command CREATES the payment — no pre-existing aggregate to load);
// unique Payment.orderId is the DB-level backstop to paymentExists.
export async function chargeOrder(
  tx: ChargeTx,
  // userId is optional here (not on ChargeTx) so a legacy caller that never had it to
  // give still compiles; chargeOrder is the one place that decides the missing case
  // becomes a stored null rather than a crash.
  p: { eventId: string; orderId: string; userId?: string | null; amount: number }
): Promise<ChargeOutcome> {
  const fresh = await tx.markProcessed(p.eventId, CHARGE_PAYMENT);
  if (!fresh) return "DUPLICATE";

  if (await tx.paymentExists(p.orderId)) return "ALREADY_CHARGED";

  const outcome = simulateCharge(p.amount);
  const paymentId = await tx.createPayment(
    p.orderId,
    p.amount,
    outcome,
    p.userId ?? null
  );
  await tx.createAttempt(paymentId, outcome);

  if (outcome === "SUCCEEDED") {
    await tx.enqueue(PAYMENT_SUCCEEDED, p.orderId, {
      orderId: p.orderId,
      paymentId,
      amount: p.amount,
    });
  } else if (outcome === "FAILED") {
    await tx.enqueue(PAYMENT_FAILED, p.orderId, {
      orderId: p.orderId,
      reason: "CARD_DECLINED",
    });
  }
  // PROCESSING: recorded (payment + attempt) but emits nothing — the inbound
  // webhook finalizes it later (Task 3).
  return outcome;
}
