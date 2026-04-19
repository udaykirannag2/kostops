import { useMemo } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import type { DashboardPanel } from '../../../api/client';

const CURRENCY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function MonthlyTrendPanel({ panel }: { panel: DashboardPanel }) {
  const data = useMemo(
    () => (panel.data as Array<{ period: string; cost: number }>).map((d) => ({
      period: d.period,
      cost:   Number(d.cost ?? 0),
    })),
    [panel.data],
  );

  if (panel.kind === 'error') {
    return <PanelError title={panel.title || 'Monthly spend'} error={panel.error ?? 'Query failed'} />;
  }

  const total = data.reduce((sum, d) => sum + d.cost, 0);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-800">{panel.title}</h3>
        <span className="text-xs text-slate-500">Total: {CURRENCY.format(total)}</span>
      </div>
      {data.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="period" fontSize={11} tick={{ fill: '#64748b' }} />
              <YAxis fontSize={11} tick={{ fill: '#64748b' }} tickFormatter={(v) => CURRENCY.format(Number(v))} />
              <Tooltip
                formatter={(v: number) => CURRENCY.format(v)}
                labelStyle={{ color: '#334155', fontSize: 12 }}
                contentStyle={{ borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 12 }}
              />
              <Bar dataKey="cost" fill="#6366f1" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-40 items-center justify-center text-sm text-slate-400">
      No spend for the selected filters.
    </div>
  );
}

function PanelError({ title, error }: { title: string; error: string }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4">
      <h3 className="text-sm font-semibold text-red-800">{title}</h3>
      <p className="mt-1 text-xs text-red-700">{error}</p>
    </div>
  );
}
