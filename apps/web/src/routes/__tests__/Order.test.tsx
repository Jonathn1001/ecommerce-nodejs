import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { makeQueryClient } from "../../api/queryClient";
import { HttpError } from "../../api/errors";
import * as ordersApi from "../../api/orders";
import * as productsApi from "../../api/products";
import { Order } from "../Order";

// The route opens a real EventSource, which does not exist in jsdom (nor as a Node 22 global).
// The ladder itself is proved in useOrderStream's own suite; here it is stubbed so these tests
// stay about the page.
vi.mock("../../hooks/useOrderStream", () => ({
  useOrderStream: () => ({ polling: false, failedAt: null }),
  POLL_INTERVAL_MS: 3000,
}));

function renderAt(id: string) {
  const router = createMemoryRouter([{ path: "/orders/:id", element: <Order /> }], {
    initialEntries: [`/orders/${id}`],
  });
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
const detail = (over = {}) => ({
  id: "o1",
  userId: "u1",
  status: "PENDING" as const,
  totalPrice: 1800,
  items: [{ productId: "p1", quantity: 2, unitPrice: 900 }],
  createdAt: "2026-08-03T00:00:00.000Z",
  ...over,
});
afterEach(() => vi.restoreAllMocks());

it("shows the captured unit price, the total and the status", async () => {
  vi.spyOn(ordersApi, "getOrder").mockResolvedValue(detail());
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([
    { id: "p1", type: "ELECTRONICS", name: "Widget", price: 950, version: 2 },
  ]);
  renderAt("o1");
  expect(await screen.findByText("Widget")).toBeInTheDocument();
  // 900 is what the order captured; the catalogue now says 950. The order wins.
  expect(screen.getByText("$9.00")).toBeInTheDocument();
  expect(screen.getByText("$18.00")).toBeInTheDocument();
  expect(screen.getByText("PENDING")).toBeInTheDocument();
});

it("degrades to the id for a product the catalogue no longer has", async () => {
  vi.spyOn(ordersApi, "getOrder").mockResolvedValue(detail());
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([]);
  renderAt("o1");
  expect(await screen.findByText("p1")).toBeInTheDocument();
});

it("renders a not-found view for someone else's order", async () => {
  vi.spyOn(ordersApi, "getOrder").mockRejectedValue(new HttpError(404));
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([]);
  renderAt("nope");
  expect(await screen.findByText(/not found/i)).toBeInTheDocument();
});

it("renders the pipeline for the order's status", async () => {
  vi.spyOn(ordersApi, "getOrder").mockResolvedValue(
    detail({ status: "AWAITING_PAYMENT" })
  );
  vi.spyOn(productsApi, "listProducts").mockResolvedValue([]);
  renderAt("o1");
  expect(await screen.findByText("Inventory reserved")).toBeInTheDocument();
  expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent("Payment");
});
