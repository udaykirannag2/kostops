import { } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { MessageSquare, AlertTriangle, LogOut, TrendingDown, LayoutDashboard } from 'lucide-react';
import type { AuthUser } from 'aws-amplify/auth';
import clsx from 'clsx';
import Chat from './components/Chat';
import Findings from './components/Findings';
import Dashboard from './components/Dashboard';

interface AppProps {
  signOut?: () => void;
  user?:    AuthUser;
}

export default function App({ signOut, user }: AppProps) {
  const email = (user?.signInDetails?.loginId ?? 'User').split('@')[0];

  return (
    <BrowserRouter>
      <div className="flex h-screen bg-gray-50 font-sans">

        {/* ── Sidebar ──────────────────────────────────────────────────────── */}
        <aside className="w-56 flex-shrink-0 bg-gray-900 flex flex-col">

          {/* Logo */}
          <div className="px-5 py-5 border-b border-gray-800">
            <div className="flex items-center gap-2">
              <TrendingDown className="text-brand-500" size={20} />
              <span className="text-white font-bold text-lg tracking-tight">KostOps</span>
            </div>
            <p className="text-gray-500 text-xs mt-0.5">AWS FinOps Agent</p>
          </div>

          {/* Nav */}
          <nav className="flex-1 px-3 py-4 space-y-1">
            <SidebarLink to="/dashboard" icon={<LayoutDashboard size={16} />} label="Dashboard" />
            <SidebarLink to="/chat"      icon={<MessageSquare  size={16} />} label="Chat" />
            <SidebarLink to="/findings"  icon={<AlertTriangle  size={16} />} label="Findings" />
          </nav>

          {/* User */}
          <div className="px-4 py-4 border-t border-gray-800">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <p className="text-gray-300 text-sm font-medium truncate">{email}</p>
                <p className="text-gray-600 text-xs">Engineer</p>
              </div>
              <button
                onClick={signOut}
                className="text-gray-500 hover:text-gray-300 transition-colors p-1 rounded"
                title="Sign out"
              >
                <LogOut size={15} />
              </button>
            </div>
          </div>
        </aside>

        {/* ── Main content ─────────────────────────────────────────────────── */}
        <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <Routes>
            <Route path="/"          element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/chat"      element={<Chat />} />
            <Route path="/findings"  element={<Findings />} />
          </Routes>
        </main>

      </div>
    </BrowserRouter>
  );
}

function SidebarLink({
  to, icon, label,
}: {
  to: string; icon: React.ReactNode; label: string;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors',
          isActive
            ? 'bg-brand-600 text-white'
            : 'text-gray-400 hover:text-white hover:bg-gray-800',
        )
      }
    >
      {icon}
      {label}
    </NavLink>
  );
}
