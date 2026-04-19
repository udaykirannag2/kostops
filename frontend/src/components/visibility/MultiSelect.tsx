import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import clsx from 'clsx';

/**
 * Lightweight multi-select dropdown.
 * - Values are opaque strings; the label formatter decorates them for display.
 * - Closes on outside click. Arrow-key navigation is deliberately out of scope
 *   for this MVP — keyboard shoppers can still tab to each checkbox.
 */
export interface MultiSelectOption {
  value: string;
  label: string;
  /** Optional sublabel rendered smaller beside the main label */
  hint?: string;
}

interface MultiSelectProps {
  label:       string;
  options:     MultiSelectOption[];
  selected:    string[];
  onChange:    (next: string[]) => void;
  placeholder?: string;
  /** Max options shown before scroll */
  maxHeight?:   number;
  disabled?:    boolean;
}

export function MultiSelect({
  label, options, selected, onChange, placeholder = 'Any', maxHeight = 280, disabled,
}: MultiSelectProps) {
  const [open, setOpen]     = useState(false);
  const [query, setQuery]   = useState('');
  const rootRef             = useRef<HTMLDivElement>(null);
  const selectedSet         = useMemo(() => new Set(selected), [selected]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      o.label.toLowerCase().includes(q) || (o.hint ?? '').toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  function toggle(value: string) {
    const next = new Set(selectedSet);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(Array.from(next));
  }

  function clearAll(e: React.MouseEvent) {
    e.stopPropagation();
    onChange([]);
  }

  const summary = selected.length === 0
    ? placeholder
    : selected.length === 1
      ? options.find((o) => o.value === selected[0])?.label ?? selected[0]
      : `${selected.length} selected`;

  return (
    <div ref={rootRef} className="relative">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500 mb-1">{label}</div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          'group inline-flex w-full min-w-[160px] items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-left text-sm',
          'hover:border-slate-300 focus:border-indigo-400 focus:outline-none',
          disabled && 'cursor-not-allowed opacity-50',
          selected.length > 0 && 'border-indigo-200 bg-indigo-50/40',
        )}
      >
        <span className={clsx('truncate', selected.length === 0 && 'text-slate-400')}>{summary}</span>
        <span className="flex items-center gap-1 shrink-0 text-slate-400">
          {selected.length > 0 && (
            <X
              size={14}
              className="hover:text-slate-600"
              onClick={clearAll}
              role="button"
              aria-label="Clear"
            />
          )}
          <ChevronDown size={14} className={clsx('transition-transform', open && 'rotate-180')} />
        </span>
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-[min(360px,calc(100vw-2rem))] rounded-md border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-100 p-2">
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter…"
                className="w-full rounded border border-slate-200 bg-white py-1 pl-7 pr-2 text-xs outline-none focus:border-indigo-400"
              />
            </div>
          </div>
          <ul className="overflow-y-auto" style={{ maxHeight }}>
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-xs text-slate-400">No matches</li>
            )}
            {filtered.map((o) => {
              const checked = selectedSet.has(o.value);
              return (
                <li key={o.value}>
                  <button
                    type="button"
                    onClick={() => toggle(o.value)}
                    className={clsx(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
                      checked ? 'bg-indigo-50 text-indigo-900' : 'hover:bg-slate-50',
                    )}
                  >
                    <span className={clsx(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                      checked ? 'border-indigo-500 bg-indigo-500 text-white' : 'border-slate-300',
                    )}>
                      {checked && <Check size={11} strokeWidth={3} />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.hint && <span className="shrink-0 text-xs text-slate-400">{o.hint}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          {selected.length > 0 && (
            <div className="flex items-center justify-between border-t border-slate-100 px-3 py-1.5">
              <span className="text-xs text-slate-500">{selected.length} selected</span>
              <button
                type="button"
                onClick={() => onChange([])}
                className="text-xs text-indigo-600 hover:text-indigo-800"
              >
                Clear all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
