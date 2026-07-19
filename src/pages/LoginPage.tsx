import { FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { loginWithEmail } from "@/services/authService";
import { useAuth } from "@/hooks/useAuth";

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const nextPath = (location.state as { from?: string } | null)?.from ?? "/admin";

  if (!loading && isAuthenticated) {
    return <Navigate to={nextPath} replace />;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      await loginWithEmail(email.trim(), password);
      navigate(nextPath, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={{ minHeight: "100vh", background: "#f9fafb", display: "grid", placeItems: "center", padding: 24 }}>
      <form onSubmit={handleSubmit} style={{ width: "100%", maxWidth: 380, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 24, color: "#111827", fontFamily: "system-ui, sans-serif" }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Event Admin</h1>
        <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 20 }}>Sign in with your Supabase admin account.</p>

        <label style={{ display: "block", fontSize: 12, color: "#6b7280", marginBottom: 4 }}>Email</label>
        <input type="email" value={email} onChange={event => setEmail(event.target.value)} required style={inputStyle} />

        <label style={{ display: "block", fontSize: 12, color: "#6b7280", margin: "12px 0 4px" }}>Password</label>
        <input type="password" value={password} onChange={event => setPassword(event.target.value)} required style={inputStyle} />

        {error && <p style={{ marginTop: 12, color: "#b91c1c", fontSize: 13 }}>{error}</p>}

        <button disabled={submitting} style={{ width: "100%", marginTop: 18, padding: 10, background: submitting ? "#9ca3af" : "#6366f1", color: "#fff", border: "none", borderRadius: 6, fontWeight: 700 }}>
          {submitting ? "Signing in..." : "Sign In"}
        </button>
      </form>
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 4,
  color: "#111827",
  background: "#fff",
};
