import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import clsx from 'clsx';
import SidebarNav from './SidebarNav';
import PageHeader from './PageHeader';
import { HeaderActionsProvider } from './HeaderActions';
import { useAgentDock } from './AgentDock';

interface AppShellProps {
  userEmail: string;
  signOut?:  () => void;
}

const DEFAULT_CONTEXT = {
  scope:       'All accounts · Last 30 days',
  transcript:  [],
};

const DEFAULT_SUGGESTIONS = [
  'What is my top spend driver?',
  'Any anomalies this week?',
  'Show savings opportunities',
];

export default function AppShell({ userEmail, signOut }: AppShellProps) {
  const { pathname }                = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const dock = useAgentDock({
    context:     DEFAULT_CONTEXT,
    suggestions: DEFAULT_SUGGESTIONS,
    nudge:       null,
  });

  return (
    /* HeaderActionsProvider wraps the whole shell so pages (inside Outlet)
       can inject actions that PageHeader reads via context. */
    <HeaderActionsProvider>
      <div className="relative flex h-screen overflow-hidden bg-atlas-bg font-sans antialiased">

        {/* ── Desktop sidebar ───────────────────────────────────────── */}
        <aside className="hidden md:flex md:flex-col">
          <SidebarNav userEmail={userEmail} signOut={signOut} />
        </aside>

        {/* ── Mobile backdrop ───────────────────────────────────────── */}
        <div
          className={clsx(
            'fixed inset-0 z-40 bg-zinc-950/50 backdrop-blur-sm transition-opacity duration-200 md:hidden',
            mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
          aria-hidden={!mobileOpen}
          onClick={() => setMobileOpen(false)}
        />

        {/* ── Mobile sidebar drawer ─────────────────────────────────── */}
        <aside
          className={clsx(
            'fixed inset-y-0 left-0 z-50 transform shadow-2xl transition-transform duration-200 ease-out md:hidden',
            mobileOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <SidebarNav
            userEmail={userEmail}
            signOut={signOut}
            onNavigate={() => setMobileOpen(false)}
          />
        </aside>

        {/* ── Main content column ───────────────────────────────────── */}
        <div
          className="flex min-w-0 flex-1 flex-col"
          style={{
            marginRight: dock.reservedWidth,
            transition: 'margin-right 240ms cubic-bezier(0.2, 0.8, 0.2, 1)',
          }}
        >

          {/* Mobile top bar */}
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-200/80 bg-white px-4 md:hidden">
            <div className="flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded bg-atlas-brandAtlas">
                <span className="text-[11px] font-bold text-white">K</span>
              </div>
              <span className="text-sm font-semibold text-zinc-900">KostOps</span>
            </div>
            <button
              type="button"
              className="rounded-md p-2 text-zinc-500 hover:bg-zinc-100"
              onClick={() => setMobileOpen((o) => !o)}
              aria-expanded={mobileOpen}
              aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            >
              {mobileOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>

          {/* Page header — topbar + filter bar */}
          <PageHeader
            pathname={pathname}
            userEmail={userEmail}
            signOut={signOut}
          />

          {/* Scrollable page content */}
          <main className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-screen-xl px-6 py-6 md:px-8 md:py-7">
              <Outlet />
            </div>
          </main>

        </div>

        {/* AgentDock — absolute inside relative root, floats right */}
        {dock.node}

      </div>
    </HeaderActionsProvider>
  );
}
