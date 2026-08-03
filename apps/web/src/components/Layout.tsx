import { Link, Outlet, useNavigate } from "react-router";
import { useSession, useInvalidateSession } from "../hooks/useSession";
import { logout } from "../api/session";
import { Button } from "./Button";

export function Layout() {
  const { data } = useSession();
  const invalidate = useInvalidateSession();
  const navigate = useNavigate();
  const count = (data?.cart?.items ?? []).reduce((n, i) => n + i.quantity, 0);

  async function signOut() {
    await logout();
    await invalidate();
    navigate("/");
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-8 flex items-center justify-between">
        <Link to="/" className="text-lg font-medium">
          Storefront
        </Link>
        <nav className="flex items-center gap-4">
          <Link to="/cart" className="datum text-sm">
            Cart ({count})
          </Link>
          {data?.authenticated ? (
            <Button onClick={signOut}>Sign out</Button>
          ) : (
            <Link to="/login" className="datum text-sm underline">
              Sign in
            </Link>
          )}
        </nav>
      </header>
      <Outlet />
    </div>
  );
}
