import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, LogOut } from 'lucide-react';
import clsx from 'clsx';
import { NAV_SECTIONS, sectionIdForPath } from '../../nav/config';

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
  const { pathname }   = useLocation();
  const routeSection   = sectionIdForPath(pathname);
  const [openSectionId, setOpenSectionId] = useState<string | null>(() => routeSection);

  useEffect(() => {
    if (routeSection) setOpenSectionId(routeSection);
  }, [routeSection]);

  function onSectionClick(id: string) {
    setOpenSectionId(prev => {
      const section        = NAV_SECTIONS.find(s => s.id === id);
      const hasActiveChild = section?.children.some(c => c.path === pathname) ?? false;
      // Never collapse the section that contains the current page
      if (prev === id && !hasActiveChild) return null;
      return id;
    });
  }

  return (
    <div className={clsx('flex h-full flex-col bg-zinc-950 text-zinc-300', className)}>

      {/* ── Brand lockup ──────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-white/[0.06] px-4 py-[1.0625rem]">
        <div className="flex items-center gap-2.5">
          {/* "K" monogram */}
          <div className="flex h-[1.875rem] w-[1.875rem] shrink-0 items-center justify-center rounded-[6px] bg-brand-600 shadow-sm">
            <span className="text-[13px] font-bold leading-none tracking-tight text-white">K</span>
          </div>
          <div className="leading-none">
            <p className="text-[13.5px] font-semibold tracking-tight text-white">KostOps</p>
            <p className="mt-[3px] text-[0.625rem] font-medium text-zinc-500">FinOps Platform</p>
          </div>
        </div>
      </div>

      {/* ── Primary navigation ────────────────────────────────────────── */}
      <nav className="scrollbar-dark flex-1 overflow-y-auto overflow-x-hidden px-2 py-2.5">
        <ul className="space-y-px">
          {NAV_SECTIONS.map(section => {
            const Icon           = section.icon;
            const isOpen         = openSectionId === section.id;
            const hasActiveChild = section.children.some(c => c.path === pathname);

            return (
              <li key={section.id}>
                {/* Thin separator before Admin */}
                {section.id === 'admin' && (
                  <div className="mx-3 mb-2 mt-1.5 h-px bg-white/[0.06]" aria-hidden="true" />
                )}

                {/* Section toggle */}
                <button
                  type="button"
                  onClick={() => onSectionClick(section.id)}
                  className={clsx(
                    'flex w-full items-center gap-2.5 rounded-lg px-3 py-[0.4375rem] text-left text-[13px] font-medium transition-colors duration-100',
                    hasActiveChild
                      ? 'bg-white/[0.07] text-white'
                      : isOpen
                        ? 'bg-white/[0.04] text-zinc-200'
                        : 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200',
                  )}
                >
                  <Icon
                    size={15}
                    strokeWidth={1.75}
                    className={clsx(
                      'shrink-0 transition-colors',
                      hasActiveChild
                        ? 'text-brand-400'
                        : isOpen
                          ? 'text-zinc-400'
                          : 'text-zinc-500',
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{section.label}</span>
                  <ChevronDown
                    size={13}
                    strokeWidth={2.25}
                    className={clsx(
                      'shrink-0 text-zinc-600 transition-transform duration-200',
                      isOpen && 'rotate-180',
                    )}
                  />
                </button>

                {/* Children — CSS grid collapse trick */}
                <div
                  className={clsx(
                    'grid transition-[grid-template-rows] duration-200 ease-out',
                    isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
                  )}
                >
                  <div className="overflow-hidden">
                    <ul className="relative space-y-px py-1 pl-[0.3125rem]">
                      {/* Vertical guide rail */}
                      <div
                        className="pointer-events-none absolute bottom-1 left-[1.3125rem] top-1 w-px bg-white/[0.07]"
                        aria-hidden="true"
                      />

                      {section.children.map(child => {
                        const isActive = pathname === child.path;
                        return (
                          <li key={child.path} className="relative">
                            {/* Active dot — sits on the guide rail */}
                            {isActive && (
                              <span
                                className="pointer-events-none absolute left-[1.0625rem] top-1/2 h-[5px] w-[5px] -translate-y-1/2 rounded-full bg-brand-400"
                                aria-hidden="true"
                              />
                            )}
                            <NavLink
                              to={child.path}
                              onClick={onNavigate}
                              className={clsx(
                                'block rounded-md py-[0.3125rem] pl-9 pr-3 text-[12.5px] font-medium transition-colors duration-100',
                                isActive
                                  ? 'bg-white/[0.07] text-zinc-100'
                                  : 'text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300',
                              )}
                            >
                              {child.label}
                            </NavLink>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* ── User footer ───────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-white/[0.06] p-2">
        <div className="flex items-center gap-2.5 rounded-lg px-2 py-[0.4375rem]">
          {/* Avatar circle */}
          <div className="flex h-[1.625rem] w-[1.625rem] shrink-0 items-center justify-center rounded-full bg-zinc-700 text-[10px] font-semibold text-zinc-200">
            {initials(userEmail)}
          </div>
          <p className="min-w-0 flex-1 truncate text-[12px] font-medium text-zinc-400">
            {userEmail}
          </p>
          <button
            type="button"
            onClick={signOut}
            title="Sign out"
            className="shrink-0 rounded-md p-1.5 text-zinc-600 transition-colors hover:bg-white/[0.06] hover:text-zinc-300"
          >
            <LogOut size={13.5} strokeWidth={1.75} />
          </button>
        </div>
      </div>

    </div>
  );
}
