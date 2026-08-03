import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { register } from "../api/session";
import { Button } from "../components/Button";
import { Field } from "../components/Field";

export function Register() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as { from?: string } | null;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setEmailError(null);
    setError(null);
    setPending(true);
    try {
      const res = await register(email, password, name);
      if (res.status === 409) return setEmailError("That email is already registered.");
      if (res.status === 429)
        return setError("Too many attempts. Wait a minute and try again.");
      if (!res.ok) return setError("Could not create the account. Try again.");
      // Registering does not sign you in — identity returns no tokens and the gateway sets no
      // cookies here. Carry the email so the next step is one field, not two, and carry `from`
      // along so add-to-cart -> login -> register -> login still returns to the product.
      navigate("/login", { state: { email, from: state?.from }, replace: true });
    } catch {
      setError("Could not reach the server. Check your connection.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto flex max-w-sm flex-col gap-4">
      <h1 className="text-2xl">Create account</h1>
      <Field
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <Field
        label="Email"
        type="email"
        value={email}
        error={emailError ?? undefined}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <Field
        label="Password"
        type="password"
        minLength={8}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {error ? <p className="text-sm text-[color:var(--color-fail)]">{error}</p> : null}
      <Button type="submit" disabled={pending}>
        Create account
      </Button>
      <Link to="/login" className="datum text-sm underline">
        Sign in instead
      </Link>
    </form>
  );
}
