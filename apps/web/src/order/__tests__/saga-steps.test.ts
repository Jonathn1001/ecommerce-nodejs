import { stepsFor, type FailedAt } from "../saga-steps";

const stateOf = (status: Parameters<typeof stepsFor>[0], failedAt: FailedAt = null) =>
  Object.fromEntries(stepsFor(status, failedAt).map((s) => [s.key, s.state]));

it("PENDING means placed, with the reservation in flight", () => {
  expect(stateOf("PENDING")).toEqual({
    placed: "done",
    reserved: "active",
    payment: "pending",
    confirmed: "pending",
  });
});

// The whole basis of the tracker: an order cannot reach AWAITING_PAYMENT unless the
// reservation succeeded (services/order/src/transition.ts:14).
it("AWAITING_PAYMENT proves the reservation succeeded", () => {
  expect(stateOf("AWAITING_PAYMENT")).toEqual({
    placed: "done",
    reserved: "done",
    payment: "active",
    confirmed: "pending",
  });
});

it("CONFIRMED completes every step", () => {
  expect(stateOf("CONFIRMED")).toEqual({
    placed: "done",
    reserved: "done",
    payment: "done",
    confirmed: "done",
  });
});

it("a cancellation seen during PENDING failed at the reservation", () => {
  expect(stateOf("CANCELLED", "PENDING")).toEqual({
    placed: "done",
    reserved: "failed",
    payment: "pending",
    confirmed: "pending",
  });
});

it("a cancellation seen during AWAITING_PAYMENT failed at the payment", () => {
  expect(stateOf("CANCELLED", "AWAITING_PAYMENT")).toEqual({
    placed: "done",
    reserved: "done",
    payment: "failed",
    confirmed: "pending",
  });
});

// Cold load: the status alone cannot say which leg failed, and guessing "payment" would state
// a falsehood for every reservation-failed order.
it("a cold-loaded cancellation blames no step", () => {
  const states = stateOf("CANCELLED");
  expect(Object.values(states)).not.toContain("failed");
  expect(states.placed).toBe("done");
});

it("labels every step, in saga order", () => {
  expect(stepsFor("PENDING").map((s) => s.key)).toEqual([
    "placed",
    "reserved",
    "payment",
    "confirmed",
  ]);
  expect(stepsFor("PENDING").every((s) => s.label.length > 0)).toBe(true);
});
