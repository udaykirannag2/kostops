import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import type { AuthUser } from 'aws-amplify/auth';
import AppShell from './components/layout/AppShell';
import Chat from './components/Chat';
import Findings from './components/Findings';
import Integrations from './components/Integrations';
import PlaceholderFromNav from './pages/PlaceholderFromNav';
import MembersPage from './pages/settings/MembersPage';
import { AdminRoute } from './auth/AdminRoute';
import { NativeDashboard } from './components/visibility/NativeDashboard';
import ScopesPage          from './pages/budget/ScopesPage';
import BudgetsPage         from './pages/budget/BudgetsPage';
import BudgetDashboardPage from './pages/budget/BudgetDashboardPage';
import AllocationsPage     from './pages/budget/AllocationsPage';

interface AppProps {
  signOut?: () => void;
  user?: AuthUser;
}

export default function App({ signOut, user }: AppProps) {
  const email = user?.signInDetails?.loginId ?? 'user@example.com';

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell userEmail={email} signOut={signOut} />}>
          <Route index element={<Navigate to="/visibility/billing-summary" replace />} />

          {/* Cost Visibility */}
          <Route path="/visibility/billing-summary" element={<NativeDashboard type="billing-summary" />} />
          <Route path="/visibility/compute"         element={<NativeDashboard type="compute" />} />
          <Route path="/visibility/storage"         element={<NativeDashboard type="storage" />} />
          <Route path="/visibility/ai-ml"           element={<NativeDashboard type="ai-ml" />} />
          <Route path="/visibility/scopes"           element={<ScopesPage />} />
          <Route path="/visibility/budgets"          element={<BudgetsPage />} />
          <Route path="/visibility/budget-dashboard" element={<BudgetDashboardPage />} />
          <Route
            path="/visibility/allocations"
            element={<AdminRoute><AllocationsPage /></AdminRoute>}
          />

          {/* Optimization */}
          <Route path="/optimization/opportunities"         element={<Findings />} />
          <Route path="/optimization/coverage-commitments"  element={<NativeDashboard type="commitments" />} />
          <Route path="/optimization/rightsizing"           element={<NativeDashboard type="rightsizing" />} />
          <Route path="/optimization/savings-tracker"       element={<PlaceholderFromNav />} />
          <Route path="/optimization/recommendations"       element={<PlaceholderFromNav />} />

          {/* Integrations */}
          <Route path="/integrations/cloud-accounts" element={<PlaceholderFromNav />} />
          <Route path="/integrations/data-sources"   element={<PlaceholderFromNav />} />
          <Route path="/integrations/destinations"   element={<PlaceholderFromNav />} />
          <Route path="/integrations/connectors"     element={<Integrations />} />

          {/* Assistant */}
          <Route path="/assistant/chat"      element={<Chat />} />
          <Route path="/assistant/playbooks" element={<PlaceholderFromNav />} />
          <Route path="/assistant/history"   element={<PlaceholderFromNav />} />

          {/* Admin */}
          <Route path="/admin/workspace"   element={<PlaceholderFromNav />} />
          <Route
            path="/admin/users-roles"
            element={<AdminRoute><MembersPage /></AdminRoute>}
          />
          <Route path="/admin/policies"    element={<PlaceholderFromNav />} />
          <Route path="/admin/settings"    element={<PlaceholderFromNav />} />
        </Route>

        {/* Legacy redirects */}
        <Route path="/dashboard"                  element={<Navigate to="/visibility/billing-summary"   replace />} />
        <Route path="/visibility/overview"        element={<Navigate to="/visibility/billing-summary"   replace />} />
        <Route path="/findings"                   element={<Navigate to="/optimization/opportunities"   replace />} />
        <Route path="/chat"                       element={<Navigate to="/assistant/chat"               replace />} />
        <Route path="/integrations"               element={<Navigate to="/integrations/connectors"      replace />} />
        <Route path="/visibility/cost-analytics"  element={<Navigate to="/visibility/billing-summary"   replace />} />

        <Route path="*" element={<Navigate to="/visibility/billing-summary" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
