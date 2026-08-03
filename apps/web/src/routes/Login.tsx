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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await login(email, password);
    if (res.status === 401) return setError("That email or password is wrong.");
    if (res.status === 429)
      return setError("Too many attempts. Wait a minute and try again.");
    if (!res.ok) return setError("Could not sign in. Try again.");
    await invalidate();
    navigate(state?.from ?? "/", { replace: true });
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
      <Button type="submit">Sign in</Button>
      <Link to="/register" className="datum text-sm underline">
        Create an account
      </Link>
    </form>
  );
}
