import { useMemo } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import clsx from 'clsx';
import { NAV_SECTIONS } from '../../nav/config';
import { useRole } from '../../auth/useRole';

interface SidebarNavProps {
  userEmail:   string;
  signOut?:    () => void;
  onNavigate?: () => void;
  className?:  string;
}

/** Avatar initials from email — "john.doe@…" → "JD", "alice@…" → "AL" */
function initials(email: string): string {
  const name  = email.split('@')[0];
  const parts = name.split(/[._-]/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export default function SidebarNav({ userEmail, signOut, onNavigate, className }: SidebarNavProps) {
  const { pathname } = useLocation();
  const { isAdmin }  = useRole();

  const visibleSections = useMemo(() => {
    return NAV_SECTIONS
      .map((s) => ({
        ...s,
        children: s.children.filter((c) => isAdmin || !c.adminOnly),
      }))
      .filter((s) => s.children.length > 0);
  }, [isAdmin]);

  return (
    <div className={clsx('flex h-full w-56 shrink-0 flex-col bg-[#0e1525] text-[#cbd2dd]', className)}>

      {/* ── Logo lockup ─────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-white/[0.06] px-[18px] py-[14px]">
        <div className="flex items-center gap-2.5">
          {/* KostOps logo — compass/eye on sky-blue → deep-blue gradient */}
          <svg width="30" height="30" viewBox="0 0 80 80" className="shrink-0" aria-hidden="true">
            <defs>
              <linearGradient id="kostops-bg" x1="0" y1="0" x2="80" y2="80" gradientUnits="userSpaceOnUse">
                <stop offset="0%"   stopColor="#38bdf8"/>
                <stop offset="100%" stopColor="#1e40af"/>
              </linearGradient>
            </defs>
            {/* Rounded-square background */}
            <rect width="80" height="80" rx="18" fill="url(#kostops-bg)"/>
            {/* Orbit ring — centred slightly below mid */}
            <circle cx="40" cy="43" r="21" fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth="1.8"/>
            {/* Upper needle — bright white kite */}
            <path d="M40 9 L35 41 L40 43.5 L45 41 Z" fill="white"/>
            {/* Lower needle — shorter, translucent */}
            <path d="M40 76 L35.5 46 L40 43.5 L44.5 46 Z" fill="rgba(186,230,253,0.72)"/>
            {/* Centre eye */}
            <circle cx="40" cy="43" r="5.5" fill="white"/>
            <circle cx="40" cy="43" r="2.2" fill="#2563eb"/>
          </svg>
          <div className="leading-none">
            <p className="text-[14px] font-semibold tracking-tight text-white" style={{ letterSpacing: '-0.01em' }}>KostOps</p>
            <p className="mt-[3px] text-[10.5px] text-[#7d8595]">FinOps Platform</p>
          </div>
        </div>
      </div>

      {/* ── Search bar ──────────────────────────────────────────────── */}
      <div className="shrink-0 px-3 py-2.5">
        <div className="flex items-center gap-2 rounded-md bg-white/[0.05] px-2.5 py-[7px] text-[12px] text-[#7d8595]">
          <span className="text-[13px]">⌕</span>
          <span className="flex-1">Search…</span>
          <span className="rounded-[3px] bg-white/[0.06] px-[5px] py-[1px] text-[10px]">⌘K</span>
        </div>
      </div>

      {/* ── Nav sections (flat list) ─────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2 pb-4">
        {visibleSections.map((section) => (
          <div key={section.id} className="mt-3.5">
            {/* Section label as small-caps gray divider */}
            <div className="px-3 py-1 text-[10.5px] font-medium uppercase tracking-[0.10em] text-[#7d8595]">
              {section.label}
            </div>

            {/* Direct nav links — no accordion */}
            {section.children.map((child) => {
              const isActive    = pathname === child.path;
              /* Findings badge: show "42" on optimization/opportunities */
              const showBadge   = child.path === '/optimization/opportunities';

              return (
                <NavLink
                  key={child.path}
                  to={child.path}
                  onClick={onNavigate}
                  className={clsx(
                    'my-px flex items-center gap-2.5 rounded-md px-3 py-[7px] text-[13px] transition-colors duration-100',
                    isActive
                      ? 'bg-[rgba(11,102,228,0.18)] font-medium text-white'
                      : 'font-normal text-[#cbd2dd] hover:bg-white/[0.05]',
                  )}
                >
                  {/* Icon placeholder dot */}
                  <span
                    className={clsx(
                      'h-[5px] w-[5px] shrink-0 rounded-full',
                      isActive ? 'bg-[#7eb1ff]' : 'bg-[#7d8595]',
                    )}
                    aria-hidden="true"
                  />
                  <span className="flex-1 truncate">{child.label}</span>
                  {showBadge && (
                    <span className="rounded-full bg-[rgba(196,103,27,0.20)] px-[6px] py-[1px] text-[10px] font-semibold text-[#f0b076]">
                      42
                    </span>
                  )}
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-white/[0.06] px-3.5 py-2.5">
        <div className="flex items-center justify-between text-[11px] text-[#7d8595]">
          {/* CUR live indicator + version */}
          <span className="flex items-center gap-1.5">
            <span className="h-[7px] w-[7px] rounded-full bg-[#3fce7a]" aria-hidden="true" />
            CUR live
          </span>
          <span>v1.4.2</span>

          {/* User avatar */}
          <button
            type="button"
            onClick={signOut}
            title={`Sign out (${userEmail})`}
            className="ml-2 flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-[#7d8595]/40 text-[10px] font-semibold text-white transition-colors hover:bg-[#7d8595]/60"
          >
            {initials(userEmail)}
          </button>
        </div>
      </div>

    </div>
  );
}
