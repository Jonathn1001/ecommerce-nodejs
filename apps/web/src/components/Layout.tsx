import { Link, Outlet, useNavigate } from "react-router";
import { useSession, useInvalidateSession } from "../hooks/useSession";
import { logout } from "../api/session";
import { Button } from "./Button";

export function Layout() {
  const { data } = useSession();
  const invalidate = useInvalidateSession();
  const navigate = useNavigate();
  const count = (data?.cart?.items ?? []).reduce((n, i) => n + i.quantity, 0);

  // Logout sits behind the 10/min auth limiter, so a 429 is reachable and leaves the cookies
  // in place — invalidating and navigating home on that response would show a signed-out
  // header for a session the server never ended. A network failure must not become an
  // unhandled rejection either, so both are caught and treated as "nothing happened".
  async function signOut() {
    try {
      const res = await logout();
      if (!res.ok) return;
    } catch {
      return;
    }
    await invalidate();
    navigate("/");
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      {/* Visible only when focused: one header is shared by every route, so without this a
          keyboard user tabs the whole nav again on every navigation. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:border focus:border-[color:var(--color-line-strong)] focus:bg-[color:var(--color-surface)] focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="mb-8 flex items-center justify-between">
        <Link to="/" className="text-lg font-medium">
          Storefront
        </Link>
        <nav className="flex items-center gap-4">
          <Link to="/cart" className="datum text-sm">
            Cart ({count})
          </Link>
          {data?.authenticated ? (
            <>
              <Link to="/orders" className="datum text-sm">
                Orders
              </Link>
              <Button onClick={signOut}>Sign out</Button>
            </>
          ) : (
            <Link to="/login" className="datum text-sm underline">
              Sign in
            </Link>
          )}
        </nav>
      </header>
      <main id="main">
        <Outlet />
      </main>
    </div>
  );
}
