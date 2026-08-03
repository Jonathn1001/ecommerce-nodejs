import { getProduct, listProducts } from "../products";

// The storefront serves a page at /products/:id and the gateway serves a resource at
// /products. If the client asked for the second at the origin root, the dev-server proxy
// would answer the first as well, and a hard refresh on a product page would render JSON.
// These assertions pin the two URL spaces apart.
function stubFetch(body: unknown) {
  const spy = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(body), { status: 200 })
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}
afterEach(() => vi.unstubAllGlobals());

it("lists products under the /api prefix, not at the origin root", async () => {
  const spy = stubFetch([]);
  await listProducts();
  expect(spy.mock.calls[0][0]).toBe("/api/products");
});

it("fetches a product under the /api prefix, never shadowing the page route", async () => {
  const spy = stubFetch({
    id: "p1",
    type: "ELECTRONICS",
    name: "Widget",
    price: 900,
    version: 1,
    attributes: {},
  });
  await getProduct("p1");
  expect(spy.mock.calls[0][0]).toBe("/api/products/p1");
  expect(spy.mock.calls[0][0]).not.toBe("/products/p1");
});

it("encodes the id so a crafted id cannot escape the path", async () => {
  const spy = stubFetch({
    id: "a/b",
    type: "ELECTRONICS",
    name: "Widget",
    price: 900,
    version: 1,
    attributes: {},
  });
  await getProduct("a/b?x=1");
  expect(spy.mock.calls[0][0]).toBe("/api/products/a%2Fb%3Fx%3D1");
});
