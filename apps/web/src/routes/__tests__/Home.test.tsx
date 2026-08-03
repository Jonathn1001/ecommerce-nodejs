import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { makeQueryClient } from "../../api/queryClient";
import { HttpError } from "../../api/errors";
import * as api from "../../api/products";
import { Home } from "../Home";

// MemoryRouter is not optional scaffolding: every ProductCard is a <Link>, which reads the
// router context directly and throws when it is null. Without it the two tests that render
// cards fail on a router error rather than on anything they are asserting.
function renderHome() {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={makeQueryClient()}>
        <Home />
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

it("shows skeletons while loading", () => {
  vi.spyOn(api, "listProducts").mockReturnValue(new Promise(() => {}));
  renderHome();
  expect(screen.getAllByTestId("skeleton").length).toBeGreaterThan(0);
});

it("renders a card per product once loaded", async () => {
  vi.spyOn(api, "listProducts").mockResolvedValue([
    product(),
    product({ id: "p2", name: "Shirt", type: "CLOTHING", price: 2450 }),
  ]);
  renderHome();
  expect(await screen.findByText("Widget")).toBeInTheDocument();
  expect(screen.getByText("Shirt")).toBeInTheDocument();
  expect(screen.getByText("$9.00")).toBeInTheDocument();
});

it("shows the empty state for an empty catalogue", async () => {
  vi.spyOn(api, "listProducts").mockResolvedValue([]);
  renderHome();
  expect(await screen.findByText(/no products/i)).toBeInTheDocument();
});

it("shows the error state when the gateway errors", async () => {
  vi.spyOn(api, "listProducts").mockRejectedValue(new HttpError(500));
  renderHome();
  expect(await screen.findByRole("alert")).toHaveTextContent("500");
});

it("filters by category", async () => {
  vi.spyOn(api, "listProducts").mockResolvedValue([
    product(),
    product({ id: "p2", name: "Shirt", type: "CLOTHING" }),
  ]);
  renderHome();
  expect(await screen.findByText("Widget")).toBeInTheDocument();
  // fireEvent, not node.click(): a raw DOM click is not wrapped in act(), so the state
  // update would not be flushed before the assertions below.
  fireEvent.click(screen.getByRole("button", { name: /clothing/i }));
  expect(screen.queryByText("Widget")).not.toBeInTheDocument();
  expect(screen.getByText("Shirt")).toBeInTheDocument();
});
