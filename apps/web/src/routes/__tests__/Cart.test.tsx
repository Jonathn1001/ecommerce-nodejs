import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { makeQueryClient } from "../../api/queryClient";
import { HttpError } from "../../api/errors";
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
