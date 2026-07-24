import { describe, it, expect } from "vitest";
import { finalizePayment, type ResolveTx } from "../resolve";
import { PAYMENT_SUCCEEDED, PAYMENT_FAILED } from "@ecom/contracts";

function fakeResolveTx(init: { status: string | null; amount?: number }) {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const attempts: string[] = [];
  let status = init.status;
  const tx: ResolveTx = {
    async loadPayment() {
      return status === null ? null : { paymentId: "pay_1", status, amount: init.amount ?? 500 };
    },
    async casStatus(_o, from, to) {
      if (status === from) { status = to; return 1; }
      return 0;
    },
    async createAttempt(_p, outcome) { attempts.push(outcome); },
    async enqueue(type, _o, payload) { emitted.push({ type, payload }); },
  };
  return { tx, emitted, attempts, statusNow: () => status };
}

describe("finalizePayment (webhook core)", () => {
  it("PROCESSING + SUCCEEDED -> FINALIZED, emits payment.succeeded(amount)", async () => {
    const f = fakeResolveTx({ status: "PROCESSING", amount: 700 });
    const r = await finalizePayment(f.tx, { orderId: "o1", outcome: "SUCCEEDED" });
    expect(r).toBe("FINALIZED");
    expect(f.statusNow()).toBe("SUCCEEDED");
    expect(f.attempts).toEqual(["SUCCEEDED"]);
    expect(f.emitted).toEqual([
      { type: PAYMENT_SUCCEEDED, payload: { orderId: "o1", paymentId: "pay_1", amount: 700 } },
    ]);
  });
  it("PROCESSING + FAILED -> FINALIZED, emits payment.failed(reason)", async () => {
    const f = fakeResolveTx({ status: "PROCESSING" });
    const r = await finalizePayment(f.tx, { orderId: "o1", outcome: "FAILED" });
    expect(r).toBe("FINALIZED");
    expect(f.emitted).toEqual([
      { type: PAYMENT_FAILED, payload: { orderId: "o1", reason: "WEBHOOK_DECLINED" } },
    ]);
  });
  it("already SUCCEEDED -> NOOP, no event (idempotent / concurrent webhook)", async () => {
    const f = fakeResolveTx({ status: "SUCCEEDED" });
    expect(await finalizePayment(f.tx, { orderId: "o1", outcome: "SUCCEEDED" })).toBe("NOOP");
    expect(f.emitted).toEqual([]);
  });
  it("unknown order -> NOT_FOUND", async () => {
    const f = fakeResolveTx({ status: null });
    expect(await finalizePayment(f.tx, { orderId: "x", outcome: "SUCCEEDED" })).toBe("NOT_FOUND");
  });
});
