import { useMemo } from 'react';
import type { DashboardPanel } from '../../../api/client';

const CURRENCY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

interface ColumnDef {
  key:       string;
  label:     string;
  align?:    'left' | 'right';
  render?:   (value: unknown, row: Record<string, unknown>) => React.ReactNode;
}

/**
 * Generic top-N table panel — used for top_services and top_accounts.
 */
export function TopTablePanel({
  panel,
  columns,
  valueKey = 'cost',
}: {
  panel:     DashboardPanel;
  columns:   ColumnDef[];
  valueKey?: string;
}) {
  const rows = panel.data as Array<Record<string, unknown>>;
  const max  = useMemo(() => {
    let m = 0;
    for (const r of rows) {
      const v = Number(r[valueKey] ?? 0);
      if (v > m) m = v;
    }
    return m;
  }, [rows, valueKey]);

  if (panel.kind === 'error') {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4">
        <h3 className="text-sm font-semibold text-red-800">{panel.title}</h3>
        <p className="mt-1 text-xs text-red-700">{panel.error ?? 'Query failed'}</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-slate-800 mb-3">{panel.title}</h3>
      {rows.length === 0 ? (
        <div className="flex h-24 items-center justify-center text-sm text-slate-400">
          No rows for the selected filters.
        </div>
      ) : (
        <div className="overflow-hidden rounded border border-slate-100">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                {columns.map((c) => (
                  <th key={c.key} className={c.align === 'right' ? 'px-3 py-2 text-right' : 'px-3 py-2'}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row, i) => {
                const cost = Number(row[valueKey] ?? 0);
                const pct  = max ? (cost / max) * 100 : 0;
                return (
                  <tr key={i} className="relative">
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={
                          c.align === 'right'
                            ? 'relative px-3 py-2 text-right tabular-nums text-slate-700'
                            : 'relative px-3 py-2 text-slate-700'
                        }
                      >
                        {c.key === valueKey && (
                          <div
                            className="pointer-events-none absolute inset-y-0 right-0 bg-indigo-50"
                            style={{ width: `${pct}%` }}
                            aria-hidden="true"
                          />
                        )}
                        <span className="relative">
                          {c.render
                            ? c.render(row[c.key], row)
                            : c.key === valueKey
                              ? CURRENCY.format(cost)
                              : String(row[c.key] ?? '')}
                        </span>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
