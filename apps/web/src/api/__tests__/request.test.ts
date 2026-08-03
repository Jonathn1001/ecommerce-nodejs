import { z } from "zod";
import { request } from "../request";
import { HttpError, NetworkError, SchemaMismatchError } from "../errors";
import { makeQueryClient } from "../queryClient";

const schema = z.object({ id: z.string() });

function mockFetch(impl: () => Promise<Response> | never) {
  vi.stubGlobal("fetch", vi.fn(impl));
}
afterEach(() => vi.unstubAllGlobals());

it("returns parsed data on a valid response", async () => {
  mockFetch(async () => new Response(JSON.stringify({ id: "p1" }), { status: 200 }));
  await expect(request("/products", schema)).resolves.toEqual({ id: "p1" });
});

it("throws HttpError carrying the status on a non-2xx", async () => {
  mockFetch(async () => new Response("nope", { status: 404 }));
  const err = await request("/products", schema).catch((e) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(404);
});

it("throws NetworkError when fetch itself rejects", async () => {
  mockFetch(() => Promise.reject(new TypeError("failed to fetch")));
  await expect(request("/products", schema)).rejects.toBeInstanceOf(NetworkError);
});

// The drift alarm. A shape mismatch is a BUG, not a user-facing condition, so it must be
// distinguishable from a 4xx or a dropped connection.
it("throws SchemaMismatchError when the body does not match the schema", async () => {
  mockFetch(async () => new Response(JSON.stringify({ id: 42 }), { status: 200 }));
  await expect(request("/products", schema)).rejects.toBeInstanceOf(SchemaMismatchError);
});

it("requests a same-origin path, never an absolute gateway URL", async () => {
  // Typed as `fetch` so `mock.calls[0][0]` is the URL argument. An untyped `vi.fn(async () =>
  // …)` infers a zero-parameter call tuple, and the assertion below stops compiling.
  const spy = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ id: "p1" }), { status: 200 })
  );
  vi.stubGlobal("fetch", spy);
  await request("/products", schema);
  expect(spy.mock.calls[0][0]).toBe("/products");
});

it("retries network failures but never schema mismatches or 4xx", () => {
  const retry = makeQueryClient().getDefaultOptions().queries!.retry as (
    n: number,
    e: Error
  ) => boolean;
  expect(retry(0, new NetworkError("x"))).toBe(true);
  expect(retry(0, new SchemaMismatchError("/products", "bad"))).toBe(false);
  expect(retry(0, new HttpError(404))).toBe(false);
  expect(retry(5, new NetworkError("x"))).toBe(false); // bounded
});
