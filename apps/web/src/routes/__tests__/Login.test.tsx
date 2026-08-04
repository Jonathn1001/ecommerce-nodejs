import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { makeQueryClient } from "../../api/queryClient";
import * as session from "../../api/session";
import { Login } from "../Login";

function renderLogin(state?: { from: string }) {
  const router = createMemoryRouter(
    [
      { path: "/login", element: <Login /> },
      { path: "/", element: <p>home</p> },
      { path: "/cart", element: <p>the cart</p> },
    ],
    { initialEntries: [{ pathname: "/login", state }] }
  );
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
const ok = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

afterEach(() => vi.restoreAllMocks());

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText(/email/i), {
    target: { value: "a@b.com" },
  });
  fireEvent.change(screen.getByLabelText(/password/i), {
    target: { value: "hunter2hunter2" },
  });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

it("returns to where the guard sent the user from", async () => {
  vi.spyOn(session, "login").mockResolvedValue(ok(200, { ok: true }));
  vi.spyOn(session, "probeSession").mockResolvedValue({
    authenticated: true,
    cart: { userId: "u1", items: [] },
  });
  renderLogin({ from: "/cart" });
  fillAndSubmit();
  expect(await screen.findByText("the cart")).toBeInTheDocument();
});

// A wrong password must not redirect — it is a rejected credential, not a missing session.
it("keeps a rejected credential on the form", async () => {
  vi.spyOn(session, "login").mockResolvedValue(ok(401, { error: "invalid credentials" }));
  renderLogin();
  fillAndSubmit();
  expect(await screen.findByText(/email or password is wrong/i)).toBeInTheDocument();
});

it("explains a 429 rather than showing a status code", async () => {
  vi.spyOn(session, "login").mockResolvedValue(ok(429, {}));
  renderLogin();
  fillAndSubmit();
  expect(await screen.findByText(/too many attempts/i)).toBeInTheDocument();
});
