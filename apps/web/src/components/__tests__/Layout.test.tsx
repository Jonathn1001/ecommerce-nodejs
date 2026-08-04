import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { makeQueryClient } from "../../api/queryClient";
import * as sessionApi from "../../api/session";
import { Layout } from "../Layout";

function renderLayout() {
  const router = createMemoryRouter(
    [{ element: <Layout />, children: [{ index: true, element: <h1>Home</h1> }] }],
    { initialEntries: ["/"] }
  );
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

afterEach(() => vi.restoreAllMocks());

// Every page shares one header, so without a skip link a keyboard user tabs the whole nav on
// every navigation before reaching what they came for.
it("offers a skip link that targets the main landmark", async () => {
  vi.spyOn(sessionApi, "probeSession").mockResolvedValue({
    authenticated: false,
    cart: null,
  });
  renderLayout();
  const skip = screen.getByRole("link", { name: /skip to content/i });
  expect(skip).toHaveAttribute("href", "#main");
  expect(screen.getByRole("main")).toHaveAttribute("id", "main");
});

it("shows the orders link only to a signed-in visitor", async () => {
  vi.spyOn(sessionApi, "probeSession").mockResolvedValue({
    authenticated: false,
    cart: null,
  });
  const { unmount } = renderLayout();
  expect(screen.queryByRole("link", { name: /^orders$/i })).not.toBeInTheDocument();
  unmount();

  vi.spyOn(sessionApi, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [] },
  });
  renderLayout();
  expect(await screen.findByRole("link", { name: /^orders$/i })).toHaveAttribute(
    "href",
    "/orders"
  );
});
