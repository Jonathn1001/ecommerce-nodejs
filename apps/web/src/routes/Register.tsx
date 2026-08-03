import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { register } from "../api/session";
import { Button } from "../components/Button";
import { Field } from "../components/Field";

export function Register() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setEmailError(null);
    setError(null);
    const res = await register(email, password, name);
    if (res.status === 409) return setEmailError("That email is already registered.");
    if (res.status === 429)
      return setError("Too many attempts. Wait a minute and try again.");
    if (!res.ok) return setError("Could not create the account. Try again.");
    // Registering does not sign you in — identity returns no tokens and the gateway sets no
    // cookies here. Carry the email so the next step is one field, not two.
    navigate("/login", { state: { email }, replace: true });
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
      <Button type="submit">Create account</Button>
      <Link to="/login" className="datum text-sm underline">
        Sign in instead
      </Link>
    </form>
  );
}
