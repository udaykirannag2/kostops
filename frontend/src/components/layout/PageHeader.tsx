import { useEffect } from 'react';
import { resolveNav } from '../../nav/config';

interface PageHeaderProps {
  pathname:  string;
  userEmail: string;
  signOut?:  () => void;
}

/** Avatar initials from email */
function initials(email: string): string {
  const name  = email.split('@')[0];
  const parts = name.split(/[._-]/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** Static filter chips for the filter bar */
const FILTER_CHIPS: { label: string; count?: string }[] = [
  { label: 'All accounts' },
  { label: 'us-east-1, us-west-2' },
  { label: 'Last 30 days' },
];

export default function PageHeader({ pathname, userEmail }: PageHeaderProps) {
  const ctx = resolveNav(pathname);

  useEffect(() => {
    document.title = ctx?.page.label ? `${ctx.page.label} · KostOps` : 'KostOps';
  }, [ctx?.page.label]);

  return (
    <>
      {/* ── Topbar ──────────────────────────────────────────────────── */}
      <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-atlas-rule bg-white px-7">

        {/* Left: breadcrumb */}
        <div>
          {ctx ? (
            <>
              <div className="mb-[1px] text-[11px] text-atlas-inkDim">
                {ctx.section.label}
              </div>
              <div
                className="text-[16px] font-semibold text-atlas-ink"
                style={{ letterSpacing: '-0.01em' }}
              >
                {ctx.page.label}
              </div>
            </>
          ) : (
            <div
              className="text-[16px] font-semibold text-atlas-ink"
              style={{ letterSpacing: '-0.01em' }}
            >
              KostOps
            </div>
          )}
        </div>

        {/* Right: sync indicator + Share + Export + avatar */}
        <div className="flex items-center gap-2.5">
          {/* Sync indicator */}
          <span className="hidden items-center gap-1.5 text-[11.5px] text-atlas-inkDim sm:inline-flex">
            <span className="h-[7px] w-[7px] rounded-full bg-atlas-ok" aria-hidden="true" />
            Synced 14m ago
          </span>

          <button
            type="button"
            className="rounded-md border border-atlas-ruleHi bg-white px-2.5 py-1.5 text-[12px] text-atlas-inkSoft transition-colors hover:bg-atlas-bg"
          >
            Share
          </button>
          <button
            type="button"
            className="rounded-md border border-atlas-ruleHi bg-white px-2.5 py-1.5 text-[12px] text-atlas-inkSoft transition-colors hover:bg-atlas-bg"
          >
            Export
          </button>

          {/* User avatar */}
          <span
            className="flex h-[30px] w-[30px] items-center justify-center rounded-full text-[11px] font-semibold text-white"
            style={{ background: 'linear-gradient(135deg, #0b66e4, #6c4ad9)' }}
            title={userEmail}
          >
            {initials(userEmail)}
          </span>
        </div>
      </header>

      {/* ── Filter chip bar ─────────────────────────────────────────── */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-atlas-rule bg-white px-7 py-2.5">
        <span className="mr-1 text-[11.5px] tracking-[0.04em] text-atlas-inkDim">Scope</span>

        {FILTER_CHIPS.map(({ label }) => (
          <span
            key={label}
            className="inline-flex items-center gap-1.5 rounded-full border border-atlas-rule bg-atlas-bg px-2.5 py-[5px] text-[12px] text-atlas-inkSoft"
          >
            {label}
            <button
              type="button"
              className="text-[11px] text-atlas-inkMute transition-colors hover:text-atlas-inkDim"
              aria-label={`Remove ${label} filter`}
            >
              ×
            </button>
          </span>
        ))}

        {/* Add filter chip */}
        <span className="cursor-pointer rounded-full border border-dashed border-atlas-ruleHi px-2.5 py-[5px] text-[12px] text-atlas-inkDim transition-colors hover:border-atlas-inkDim">
          + Add filter
        </span>

        {/* Right actions */}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="rounded-md border border-atlas-ruleHi bg-white px-3 py-1.5 text-[12px] text-atlas-inkSoft transition-colors hover:bg-atlas-bg"
          >
            Save view
          </button>
          <button
            type="button"
            className="rounded-md bg-atlas-brandAtlas px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
          >
            New report
          </button>
        </div>
      </div>
    </>
  );
}
