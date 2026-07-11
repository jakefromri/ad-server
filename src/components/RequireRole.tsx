import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '@/lib/auth';

// Route guard for /admin/* and /t/* — mirrors the API's own role checks
// (requireRole('superadmin') / tenantAccessMiddleware's tenant_admin check)
// so a signed-in user with the wrong role never sees the wrong console, even
// briefly. The API is still the actual enforcement boundary; this is UX only.
export function RequireRole({ role }: { role: 'superadmin' | 'tenant_admin' }) {
  const { session, role: currentRole, loading } = useAuth();

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  if (!session) return <Navigate to="/login" replace />;
  if (currentRole !== role) return <Navigate to="/login" replace />;

  return <Outlet />;
}
