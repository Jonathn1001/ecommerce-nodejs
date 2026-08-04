import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { makeQueryClient } from "../../api/queryClient";
import { HttpError } from "../../api/errors";
import * as ordersApi from "../../api/orders";
import { Orders } from "../Orders";

function renderList() {
  const router = createMemoryRouter(
    [
      { path: "/orders", element: <Orders /> },
      { path: "/orders/:id", element: <div>detail</div> },
    ],
    { initialEntries: ["/orders"] }
  );
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

const summary = (over = {}) => ({
  id: "o2",
  status: "CONFIRMED" as const,
  totalPrice: 2500,
  itemCount: 2,
  createdAt: "2026-08-04T10:00:00.000Z",
  ...over,
});

afterEach(() => vi.restoreAllMocks());

it("lists the caller's orders with their status and total", async () => {
  vi.spyOn(ordersApi, "listOrders").mockResolvedValue([summary()]);
  renderList();
  expect(await screen.findByText("o2")).toBeInTheDocument();
  expect(screen.getByText("CONFIRMED")).toBeInTheDocument();
  expect(screen.getByText("$25.00")).toBeInTheDocument();
  expect(screen.getByText(/2 items/)).toBeInTheDocument();
});

it("links each row to its order", async () => {
  vi.spyOn(ordersApi, "listOrders").mockResolvedValue([summary()]);
  renderList();
  expect(await screen.findByRole("link", { name: /o2/ })).toHaveAttribute(
    "href",
    "/orders/o2"
  );
});

it("shows an empty state rather than a blank page", async () => {
  vi.spyOn(ordersApi, "listOrders").mockResolvedValue([]);
  renderList();
  expect(await screen.findByText(/no orders yet/i)).toBeInTheDocument();
});

// HttpError, not NetworkError: the query client retries network failures by design (five
// bounded attempts), so a NetworkError here would be testing the retry policy, not the page.
it("shows an error state when the store answers badly", async () => {
  vi.spyOn(ordersApi, "listOrders").mockRejectedValue(new HttpError(500));
  renderList();
  expect(await screen.findByRole("alert")).toHaveTextContent("500");
});
