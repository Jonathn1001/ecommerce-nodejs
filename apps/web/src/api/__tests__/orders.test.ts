import { describeCheckoutFailure } from "../orders";
import { HttpError } from "../errors";

// Spec §D1 of 8b asked the 422 recovery to name the product; it could not, because the body
// carrying the id was discarded. This is that gap closed.
it("names the unpriced product when the 422 body says which", () => {
  const e = new HttpError(422, { error: "unpriced", productId: "p9" });
  const message = describeCheckoutFailure(e, (id) =>
    id === "p9" ? "Widget" : undefined
  );
  expect(message).toContain("Widget");
  expect(message).toMatch(/remove it/i);
});

// The catalogue is a cache, and an order can reference a product it no longer holds.
it("falls back to the generic wording when the id resolves to no name", () => {
  const e = new HttpError(422, { productId: "gone" });
  expect(describeCheckoutFailure(e, () => undefined)).toMatch(/one of these products/i);
});

it("falls back when the body names no product at all", () => {
  expect(describeCheckoutFailure(new HttpError(422, {}))).toMatch(
    /one of these products/i
  );
});

it("still explains an empty cart", () => {
  expect(describeCheckoutFailure(new HttpError(400))).toMatch(/empty/i);
});

it("stays generic for anything else", () => {
  expect(describeCheckoutFailure(new Error("boom"))).toMatch(/could not place/i);
});
