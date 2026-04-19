import { Loader2 } from 'lucide-react';
import { useRole } from './useRole';

/**
 * AdminRoute — render-level gate for admin-only pages.
 *
 * This only controls UX; the API authorizer and the agent supervisor gate
 * writes independently, so rendering the page for a viewer is harmless —
 * every mutation they attempt will 403 server-side. We still hide the page
 * because it's sensitive (identity data, settings) and clearer for users.
 */
export function AdminRoute({ children }: { children: React.ReactNode }) {
  const { isAdmin, loading } = useRole();

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-slate-500">
        <Loader2 size={16} className="animate-spin" /> Checking permissions…
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <strong>Admin access required.</strong> Ask an existing admin to promote your account.
      </div>
    );
  }

  return <>{children}</>;
}
