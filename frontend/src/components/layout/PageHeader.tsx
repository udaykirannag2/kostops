import { useEffect } from 'react';
import { resolveNav } from '../../nav/config';
import { useHeaderActions } from './HeaderActions';

interface PageHeaderProps {
  pathname: string;
}

export default function PageHeader({ pathname }: PageHeaderProps) {
  const ctx     = resolveNav(pathname);
  const actions = useHeaderActions();

  useEffect(() => {
    document.title = ctx?.page.label ? `${ctx.page.label} · KostOps` : 'KostOps';
  }, [ctx?.page.label]);

  const hasDescription = Boolean(ctx?.page.description);

  return (
    <header className="shrink-0 border-b border-zinc-200/80 bg-white px-6 md:px-8">
      <div className="flex h-[3.25rem] items-center justify-between gap-4">

        {/* Left: section chip › page title */}
        <div className="flex min-w-0 items-center gap-2">
          {ctx ? (
            <>
              <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                {ctx.section.label}
              </span>
              {/* Chevron separator */}
              <svg
                viewBox="0 0 6 10"
                className="h-2.5 w-[0.3125rem] shrink-0 text-zinc-300"
                fill="none" stroke="currentColor"
                strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="1,1 5,5 1,9" />
              </svg>
              <h1 className="truncate text-[14.5px] font-semibold tracking-tight text-zinc-900">
                {ctx.page.label}
              </h1>
            </>
          ) : (
            <h1 className="text-[14.5px] font-semibold tracking-tight text-zinc-900">KostOps</h1>
          )}
        </div>

        {/* Right: page-level actions set by each page via useSetHeaderActions() */}
        {actions && (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </div>

      {/* Sub-description row — only shown when present, collapses neatly */}
      {hasDescription && (
        <p className="pb-3 text-[12px] leading-relaxed text-zinc-400">
          {ctx!.page.description}
        </p>
      )}
    </header>
  );
}
