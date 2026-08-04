import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { login } from "../api/session";
import { useInvalidateSession } from "../hooks/useSession";
import { Button } from "../components/Button";
import { Field } from "../components/Field";

export function Login() {
  const location = useLocation();
  const navigate = useNavigate();
  const invalidate = useInvalidateSession();
  const state = location.state as { from?: string; email?: string } | null;
  const [email, setEmail] = useState(state?.email ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await login(email, password);
      if (res.status === 401) return setError("That email or password is wrong.");
      if (res.status === 429)
        return setError("Too many attempts. Wait a minute and try again.");
      if (!res.ok) return setError("Could not sign in. Try again.");
      await invalidate();
      navigate(state?.from ?? "/", { replace: true });
    } catch {
      // authRequest wraps a genuine network failure in NetworkError; either way, a rejected
      // promise here must not be an unhandled one and the submit button must recover.
      setError("Could not reach the server. Check your connection.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto flex max-w-sm flex-col gap-4">
      <h1 className="text-2xl">Sign in</h1>
      <Field
        label="Email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <Field
        label="Password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {error ? <p className="text-sm text-[color:var(--color-fail)]">{error}</p> : null}
      <Button type="submit" disabled={pending}>
        Sign in
      </Button>
      {/* Carry `from` through the register detour so add-to-cart -> login -> register ->
          login still returns to the product instead of dropping back to "/". */}
      <Link
        to="/register"
        state={{ from: state?.from }}
        className="datum text-sm underline"
      >
        Create an account
      </Link>
    </form>
  );
}
