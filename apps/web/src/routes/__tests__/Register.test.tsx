import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { makeQueryClient } from "../../api/queryClient";
import * as session from "../../api/session";
import { Register } from "../Register";
import { Login } from "../Login";

function renderRegister() {
  const router = createMemoryRouter(
    [
      { path: "/register", element: <Register /> },
      { path: "/login", element: <Login /> },
    ],
    { initialEntries: ["/register"] }
  );
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
const res = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

afterEach(() => vi.restoreAllMocks());

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Ada" } });
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@b.com" } });
  fireEvent.change(screen.getByLabelText(/password/i), {
    target: { value: "hunter2hunter2" },
  });
  fireEvent.click(screen.getByRole("button", { name: /create account/i }));
}

// Register returns 201 {userId} and NO tokens, and the gateway sets no cookies on that path —
// so a new user is still anonymous and must sign in.
it("lands on the login form with the email prefilled", async () => {
  vi.spyOn(session, "register").mockResolvedValue(res(201, { userId: "u1" }));
  renderRegister();
  fillAndSubmit();
  expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();
  expect(screen.getByLabelText(/email/i)).toHaveValue("a@b.com");
});

it("puts a duplicate email on the field with a way to sign in", async () => {
  vi.spyOn(session, "register").mockResolvedValue(
    res(409, { error: "email already registered" })
  );
  renderRegister();
  fillAndSubmit();
  expect(await screen.findByText(/already registered/i)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /sign in/i })).toBeInTheDocument();
});
