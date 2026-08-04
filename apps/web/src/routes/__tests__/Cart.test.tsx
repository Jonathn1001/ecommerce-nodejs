import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { makeQueryClient } from "../../api/queryClient";
import { HttpError, UnauthenticatedError } from "../../api/errors";
import * as productsApi from "../../api/products";
import * as cartApi from "../../api/cart";
import * as ordersApi from "../../api/orders";
import * as session from "../../api/session";
import { Cart } from "../Cart";

function renderCart() {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={makeQueryClient()}>
        <Cart />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

// A real router with an /orders/:id target, needed only where the test asserts navigation —
// the bare MemoryRouter above has no <Routes>, so a navigate() call changes the URL but
// renders nothing.
function renderCartRouted() {
  const router = createMemoryRouter(
    [
      { path: "/cart", element: <Cart /> },
      { path: "/orders/:id", element: <p>order confirmed</p> },
    ],
    { initialEntries: ["/cart"] }
  );
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
const product = (over = {}) => ({
  id: "p1",
  type: "ELECTRONICS" as const,
  name: "Widget",
  price: 900,
  version: 1,
  ...over,
});
afterEach(() => vi.restoreAllMocks());

it("joins names and prices from the catalogue", async () => {
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [{ productId: "p1", quantity: 2 }] },
  });
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([product()]);
  renderCart();
  const name = await screen.findByText("Widget");
  // Scoped to the row: with a single line in the cart, its total (900 * 2) equals the cart
  // estimate below, so an unscoped query would match both and throw on ambiguity.
  const row = name.closest("li") as HTMLElement;
  expect(within(row).getByText("$18.00")).toBeInTheDocument(); // 900 * 2
});

// Reachable with nothing broken: a product deleted from the catalogue after it was added.
it("degrades to the id for a product missing from the catalogue", async () => {
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [{ productId: "ghost", quantity: 1 }] },
  });
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([product()]);
  renderCart();
  expect(await screen.findByText("ghost")).toBeInTheDocument();
});

it("labels the total as an estimate", async () => {
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [{ productId: "p1", quantity: 1 }] },
  });
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([product()]);
  renderCart();
  expect(await screen.findByText(/estimate/i)).toBeInTheDocument();
});

// The stepper must PATCH. POST increments, so a stepper built on POST would double the line.
it("changes a quantity with PATCH, not a repeated POST", async () => {
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [{ productId: "p1", quantity: 2 }] },
  });
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([product()]);
  const set = vi
    .spyOn(cartApi, "setQuantity")
    .mockResolvedValue({ productId: "p1", quantity: 3 });
  const add = vi.spyOn(cartApi, "addItem");
  renderCart();
  await screen.findByText("Widget");
  fireEvent.click(screen.getByRole("button", { name: /increase/i }));
  expect(set).toHaveBeenCalledWith("p1", 3);
  expect(add).not.toHaveBeenCalled();
});

// Minor 4: a failed catalogue query must not read as an authoritative $0.00 — that's a
// degraded estimate, not a real one. The line itself still degrades to its id (fine, that
// fallback is for one missing product; here every product is "missing").
it("does not render an authoritative $0.00 estimate when the catalogue query fails", async () => {
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [{ productId: "p1", quantity: 1 }] },
  });
  vi.spyOn(productsApi, "listProducts").mockRejectedValue(new HttpError(500));
  renderCart();
  expect(await screen.findByText("p1")).toBeInTheDocument();
  expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  expect(await screen.findByText(/estimate unavailable/i)).toBeInTheDocument();
});

it("shows an empty state for an empty cart", async () => {
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [] },
  });
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([]);
  renderCart();
  expect(await screen.findByText(/cart is empty/i)).toBeInTheDocument();
});

it.each([
  [400, /cart is empty/i],
  [422, /no price yet/i],
])("explains a %i from checkout instead of a generic error", async (status, pattern) => {
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [{ productId: "p1", quantity: 1 }] },
  });
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([product()]);
  vi.spyOn(ordersApi, "placeOrder").mockRejectedValue(new HttpError(status));
  renderCart();
  await screen.findByText("Widget");
  fireEvent.click(screen.getByRole("button", { name: /place order/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(pattern);
});

// Headline flow of the slice: nothing previously covered a checkout that actually succeeds.
it("routes to the confirmation and invalidates the session on a successful checkout", async () => {
  const probe = vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [{ productId: "p1", quantity: 1 }] },
  });
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([product()]);
  vi.spyOn(ordersApi, "placeOrder").mockResolvedValue({
    orderId: "o1",
    status: "PENDING",
    totalPrice: 900,
    items: [{ productId: "p1", quantity: 1, unitPrice: 900 }],
  });
  renderCartRouted();
  await screen.findByText("Widget");
  const callsBeforeCheckout = probe.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: /place order/i }));
  expect(await screen.findByText("order confirmed")).toBeInTheDocument();
  await waitFor(() =>
    expect(probe.mock.calls.length).toBeGreaterThan(callsBeforeCheckout)
  );
});

// Important 1: a session that died mid-flight (refresh token expired between the last probe
// and this click) must not leave the click as an unhandled rejection — it invalidates so the
// stale "authenticated" cache gets corrected.
it("invalidates the session when a cart mutation discovers a dead session", async () => {
  const probe = vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [{ productId: "p1", quantity: 2 }] },
  });
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([product()]);
  vi.spyOn(cartApi, "setQuantity").mockRejectedValue(new UnauthenticatedError());
  renderCart();
  await screen.findByText("Widget");
  const callsBeforeClick = probe.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: /increase/i }));
  await waitFor(() => expect(probe.mock.calls.length).toBeGreaterThan(callsBeforeClick));
});

// Important 2: a 400 means the cart is already empty server-side. The recovery must not
// render stale lines and a live "Place order" button above an alert that contradicts them.
it("shows the real empty state, not stale lines plus a contradicting alert, after a 400", async () => {
  vi.spyOn(session, "probeSession")
    .mockResolvedValueOnce({
      authenticated: true,
      cart: { userId: "u1", items: [{ productId: "p1", quantity: 1 }] },
    })
    .mockResolvedValue({ authenticated: true, cart: { userId: "u1", items: [] } });
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([product()]);
  vi.spyOn(ordersApi, "placeOrder").mockRejectedValue(new HttpError(400));
  renderCart();
  await screen.findByText("Widget");
  fireEvent.click(screen.getByRole("button", { name: /place order/i }));
  expect(await screen.findByText(/cart is empty/i)).toBeInTheDocument();
  expect(screen.queryByText("Widget")).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /place order/i })).not.toBeInTheDocument();
});

// Deferred out of 8b: the stepper's floor. Decrementing the last unit removes the line via
// DELETE rather than PATCHing a zero — the stepper must not clamp at 1 and strand it.
it("removes the line when the last unit is decremented", async () => {
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [{ productId: "p1", quantity: 1 }] },
  });
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([product()]);
  const remove = vi.spyOn(cartApi, "removeItem").mockResolvedValue({ productId: "p1" });
  const set = vi.spyOn(cartApi, "setQuantity");
  renderCart();
  await screen.findByText("Widget");
  fireEvent.click(screen.getByRole("button", { name: /decrease/i }));
  expect(remove).toHaveBeenCalledWith("p1");
  expect(set).not.toHaveBeenCalled();
});

// Also deferred out of 8b: the estimate is a sum across lines, not the first line's price.
it("estimates a multi-line cart as the sum of its lines", async () => {
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: {
      userId: "u1",
      items: [
        { productId: "p1", quantity: 2 },
        { productId: "p2", quantity: 1 },
      ],
    },
  });
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([
    product(),
    product({ id: "p2", name: "Gadget", price: 250 }),
  ]);
  renderCart();
  await screen.findByText("Gadget");
  // 900 × 2 + 250 = 2050
  expect(screen.getByText("$20.50")).toBeInTheDocument();
});
