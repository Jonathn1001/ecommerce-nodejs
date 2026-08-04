import { getCart, setQuantity } from "../cart";
import { HttpError, SchemaMismatchError } from "../errors";

function setCsrf(value: string | null) {
  document.cookie = value
    ? `XSRF-TOKEN=${value}; path=/`
    : "XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
}
afterEach(() => {
  setCsrf(null);
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

// Order answers 404 `not in cart` when the line is already gone (services/order/src/app.ts,
// PATCH /cart/items/:productId, updateMany matched nothing). A stepper awaits setQuantity in
// a click handler and then invalidates the session query — an uncaught rejection here would
// skip that invalidate and leave the cart badge stale.
it("resolves instead of rejecting on a 404 from the PATCH", async () => {
  setCsrf("tok");
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => json({ error: "not in cart" }, 404))
  );

  await expect(setQuantity("p1", 3)).resolves.toEqual({ productId: "p1", quantity: 0 });
});

it("still rejects on a non-404 error", async () => {
  setCsrf("tok");
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => json({ error: "internal error" }, 500))
  );

  const err = await setQuantity("p1", 3).catch((e) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(500);
});

// Non-strict schemas let an additive server field pass silently, so drift only surfaced when
// something downstream depended on the field nobody had noticed. Order asserts these same
// schemas against its own responses, so strictness fails a backend test beside the change that
// caused it.
it("rejects a cart response carrying an unknown field", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => json({ userId: "u1", items: [], surprise: true }))
  );
  await expect(getCart()).rejects.toBeInstanceOf(SchemaMismatchError);
});
