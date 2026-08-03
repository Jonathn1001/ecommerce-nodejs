import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { makeQueryClient } from "../../api/queryClient";
import { HttpError } from "../../api/errors";
import * as api from "../../api/products";
import { Product } from "../Product";

function renderAt(id: string) {
  const router = createMemoryRouter([{ path: "/products/:id", element: <Product /> }], {
    initialEntries: [`/products/${id}`],
  });
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
const detail = (over = {}) => ({
  id: "p1",
  type: "ELECTRONICS" as const,
  name: "Widget",
  price: 900,
  version: 3,
  attributes: { manufacturer: "Acme" },
  ...over,
});

afterEach(() => vi.restoreAllMocks());

it("renders name, price and the attributes table", async () => {
  vi.spyOn(api, "getProduct").mockResolvedValue(detail());
  renderAt("p1");
  expect(await screen.findByText("Widget")).toBeInTheDocument();
  expect(screen.getByText("$9.00")).toBeInTheDocument();
  expect(screen.getByText("manufacturer")).toBeInTheDocument();
  expect(screen.getByText("Acme")).toBeInTheDocument();
});

// Reachable with nothing broken: a stale link, or a product removed between list and click.
it("renders a not-found view on 404, not a generic error", async () => {
  vi.spyOn(api, "getProduct").mockRejectedValue(new HttpError(404));
  renderAt("gone");
  expect(await screen.findByText(/not found/i)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /catalogue/i })).toBeInTheDocument();
});

it("still shows the error state for a non-404", async () => {
  vi.spyOn(api, "getProduct").mockRejectedValue(new HttpError(500));
  renderAt("p1");
  expect(await screen.findByRole("alert")).toHaveTextContent("500");
});

// attributes is z.record(z.unknown()) — values are genuinely unknown at compile time.
it("renders primitive attributes and skips non-primitive ones", async () => {
  vi.spyOn(api, "getProduct").mockResolvedValue(
    detail({ attributes: { brand: "Acme", sizes: { eu: 42 }, inStock: true } })
  );
  renderAt("p1");
  expect(await screen.findByText("brand")).toBeInTheDocument();
  expect(screen.getByText("true")).toBeInTheDocument();
  expect(screen.queryByText("sizes")).not.toBeInTheDocument();
  expect(screen.queryByText(/object Object/)).not.toBeInTheDocument();
});
