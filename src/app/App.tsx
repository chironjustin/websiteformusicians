import { Navigate, Route, Routes } from "react-router";
import { useAuth } from "@/hooks/useAuth";
import AdminPage from "@/pages/AdminPage";
import LoginPage from "@/pages/LoginPage";
import PublicEventPage from "@/pages/PublicEventPage";

function ProtectedAdminRoute() {
  const { isAuthenticated, loading, error } = useAuth();

  if (loading) {
    return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>Loading admin...</div>;
  }

  if (error) {
    return <Navigate to="/login" replace />;
  }

  return isAuthenticated ? <AdminPage /> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<PublicEventPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/admin" element={<ProtectedAdminRoute />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
