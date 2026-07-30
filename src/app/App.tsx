import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";
import { useAuth } from "@/hooks/useAuth";
import PublicEventPage from "@/pages/PublicEventPage";

const AdminPage = lazy(() => import("@/pages/AdminPage"));
const LoginPage = lazy(() => import("@/pages/LoginPage"));

function RouteFallback({ label }: { label: string }) {
  return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>{label}</div>;
}

function ProtectedAdminRoute() {
  const { isAuthenticated, loading, error } = useAuth();

  if (loading) {
    return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>Loading admin...</div>;
  }

  if (error) {
    return <Navigate to="/login" replace />;
  }

  return isAuthenticated ? (
    <Suspense fallback={<RouteFallback label="Loading admin..." />}>
      <AdminPage />
    </Suspense>
  ) : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<PublicEventPage />} />
      <Route path="/login" element={<Suspense fallback={<RouteFallback label="Loading login..." />}><LoginPage /></Suspense>} />
      <Route path="/admin" element={<ProtectedAdminRoute />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
