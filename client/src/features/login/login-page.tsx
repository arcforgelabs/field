import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/auth-context";
import { Button, Field, TextInput } from "@/components/field";
import { SignInFrame } from "./sign-in-frame";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { loginWithEmail, authenticated } = useAuth();
  const navigate = useNavigate();

  if (authenticated) {
    navigate("/jobs", { replace: true });
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;
    setLoading(true);
    setError("");
    const ok = await loginWithEmail(email.trim(), password.trim());
    setLoading(false);
    if (ok) {
      navigate("/jobs", { replace: true });
    } else {
      setError("Invalid email or password");
    }
  }

  return (
    <SignInFrame title="Sign in" subtitle="Use your work account.">
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Field label="Email address" htmlFor="login-email">
          <TextInput
            id="login-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            autoComplete="email"
            style={{ height: 48, fontSize: 16 }}
          />
        </Field>
        <Field label="Password" htmlFor="login-password" error={error || undefined}>
          <TextInput
            id="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            aria-invalid={error ? true : undefined}
            style={{ height: 48, fontSize: 16 }}
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" block disabled={loading} style={{ marginTop: 8 }}>
          {loading ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </SignInFrame>
  );
}
