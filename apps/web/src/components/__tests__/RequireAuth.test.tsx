import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { makeQueryClient } from "../../api/queryClient";
import * as session from "../../api/session";
import { RequireAuth } from "../RequireAuth";

function renderGuarded(initial = "/cart") {
  const router = createMemoryRouter(
    [
      {
        path: "/cart",
        element: (
          <RequireAuth>
            <p>the cart</p>
          </RequireAuth>
        ),
      },
      { path: "/login", element: <p>sign in please</p> },
    ],
    { initialEntries: [initial] }
  );
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
afterEach(() => vi.restoreAllMocks());

it("renders the page when a session exists", async () => {
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [] },
  });
  renderGuarded();
  expect(await screen.findByText("the cart")).toBeInTheDocument();
});

it("redirects to login when there is no session", async () => {
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: false,
    cart: null,
  });
  renderGuarded();
  expect(await screen.findByText("sign in please")).toBeInTheDocument();
});

// The whole reason the PENDING branch exists: redirecting during load would flash a
// signed-in user to /login on every cold start, before the probe has had a chance to answer.
it("shows the skeleton while the probe is pending, and redirects nowhere", async () => {
  vi.spyOn(session, "probeSession").mockReturnValue(new Promise(() => {}));
  renderGuarded();
  expect(await screen.findByTestId("skeleton")).toBeInTheDocument();
  expect(screen.queryByText("sign in please")).not.toBeInTheDocument();
  expect(screen.queryByText("the cart")).not.toBeInTheDocument();
});
