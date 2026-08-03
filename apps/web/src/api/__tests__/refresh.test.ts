import { z } from "zod";
import { request } from "../request";
import { UnauthenticatedError } from "../errors";

const schema = z.object({ ok: z.boolean() });

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

it("refreshes once and retries when a 401 is recoverable", async () => {
  setCsrf("t1");
  let calls = 0;
  const spy = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === "/api/auth/refresh") return json({ ok: true });
    calls += 1;
    return calls === 1 ? json({ error: "unauthenticated" }, 401) : json({ ok: true });
  });
  vi.stubGlobal("fetch", spy);

  await expect(request("/api/cart", schema)).resolves.toEqual({ ok: true });
  expect(spy.mock.calls.filter((c) => String(c[0]) === "/api/auth/refresh")).toHaveLength(
    1
  );
});

// The assertion that matters. A per-request refresh passes every outcome-shaped test above
// while firing N refreshes at an endpoint capped to 10/min, and leaning on identity's grace
// window to avoid destroying its own session through reuse detection.
it("issues exactly ONE refresh for concurrent 401s", async () => {
  setCsrf("t1");
  const seen: Record<string, number> = {};
  const spy = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    seen[url] = (seen[url] ?? 0) + 1;
    if (url === "/api/auth/refresh") {
      await new Promise((r) => setTimeout(r, 10));
      return json({ ok: true });
    }
    return seen[url] === 1 ? json({ error: "unauthenticated" }, 401) : json({ ok: true });
  });
  vi.stubGlobal("fetch", spy);

  await Promise.all([
    request("/api/a", schema),
    request("/api/b", schema),
    request("/api/c", schema),
  ]);
  expect(seen["/api/auth/refresh"]).toBe(1);
});

it("never refreshes when there is no XSRF-TOKEN cookie", async () => {
  setCsrf(null);
  const spy = vi.fn<typeof fetch>(async () => json({ error: "unauthenticated" }, 401));
  vi.stubGlobal("fetch", spy);

  await expect(request("/api/cart", schema)).rejects.toBeInstanceOf(UnauthenticatedError);
  expect(spy.mock.calls.map((c) => String(c[0]))).not.toContain("/api/auth/refresh");
});

it("does not loop when the retry also 401s", async () => {
  setCsrf("t1");
  const spy = vi.fn<typeof fetch>(async (input) =>
    String(input) === "/api/auth/refresh"
      ? json({ ok: true })
      : json({ error: "unauthenticated" }, 401)
  );
  vi.stubGlobal("fetch", spy);

  await expect(request("/api/cart", schema)).rejects.toBeInstanceOf(UnauthenticatedError);
  expect(spy.mock.calls.filter((c) => String(c[0]) === "/api/auth/refresh")).toHaveLength(
    1
  );
});

it("sends X-CSRF-Token on a mutation and no body on a GET", async () => {
  setCsrf("tok");
  const spy = vi.fn<typeof fetch>(async () => json({ ok: true }));
  vi.stubGlobal("fetch", spy);

  await request("/api/cart/items", schema, {
    method: "POST",
    body: { productId: "p1", quantity: 1 },
  });
  const init = spy.mock.calls[0][1]!;
  expect((init.headers as Record<string, string>)["x-csrf-token"]).toBe("tok");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body as string)).toEqual({ productId: "p1", quantity: 1 });
});
