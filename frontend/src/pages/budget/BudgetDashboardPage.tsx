import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import {
  listScopes, getCurrentBudget, listForecasts,
  type Scope, type BudgetVersion,
} from '../../api/client';

const CURRENCY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

interface ScopeRow {
  scope:       Scope;
  budget:      BudgetVersion | null;
  forecastUsd: number;
}

export default function BudgetDashboardPage() {
  const period = useMemo(currentPeriod, []);
  const [rows, setRows] = useState<ScopeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await listScopes('active');
      const populated = await Promise.all(resp.scopes.map(async (s) => {
        const [budget, forecasts] = await Promise.all([
          getCurrentBudget(s.scopeId, period),
          listForecasts(s.scopeId, period).catch(() => ({ forecasts: [] })),
        ]);
        const ceForecast = forecasts.forecasts.find((f) => f.sourceMethod === 'CE_FORECAST');
        return { scope: s, budget, forecastUsd: ceForecast?.amountUsd ?? 0 };
      }));
      setRows(populated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  const chartData = useMemo(
    () => rows
      .filter((r) => r.budget || r.forecastUsd > 0)
      .map((r) => ({
        name:     r.scope.name,
        budget:   r.budget?.amountUsd ?? 0,
        forecast: r.forecastUsd,
        over:     r.forecastUsd > (r.budget?.amountUsd ?? 0),
      }))
      .sort((a, b) => (b.budget + b.forecast) - (a.budget + a.forecast))
      .slice(0, 12),
    [rows],
  );

  const totals = useMemo(() => {
    const budget   = rows.reduce((s, r) => s + (r.budget?.amountUsd ?? 0), 0);
    const forecast = rows.reduce((s, r) => s + r.forecastUsd,             0);
    return { budget, forecast };
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Budget dashboard</h2>
          <p className="text-xs text-slate-500">Current period: {period}</p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Refresh
        </button>
      </div>

      <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <AlertTriangle size={14} /> Weekly actuals snapshot job lands in the next phase. This view shows <strong>budget vs forecast</strong> today; actuals (from CUR) switch on once <code className="text-xs">budget_refresh_handler</code> is wired.
      </div>

      {error && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Kpi label="Total budget (current)"   value={CURRENCY.format(totals.budget)}   color="text-slate-900" />
        <Kpi label="Total forecast (current)" value={CURRENCY.format(totals.forecast)} color="text-indigo-600" />
        <Kpi
          label="Scopes with budget set"
          value={`${rows.filter((r) => r.budget).length} / ${rows.length}`}
          color="text-slate-900"
        />
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-800 mb-3">Budget vs forecast by scope</h3>
        {loading && rows.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-slate-500">
            <Loader2 size={14} className="animate-spin mr-2" /> Loading…
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-slate-400">
            No scopes have a budget or forecast for {period} yet.
          </div>
        ) : (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 12, left: 12, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                <XAxis type="number" fontSize={11} tickFormatter={(v) => CURRENCY.format(Number(v))} />
                <YAxis type="category" dataKey="name" fontSize={11} width={140} tick={{ fill: '#334155' }} />
                <Tooltip
                  formatter={(v: number) => CURRENCY.format(v)}
                  contentStyle={{ borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 12 }}
                />
                <Bar dataKey="budget"   fill="#94a3b8" name="Budget"   radius={[0, 0, 0, 0]} />
                <Bar dataKey="forecast" name="Forecast" radius={[0, 4, 4, 0]}>
                  {chartData.map((d, i) => (
                    <Cell key={i} fill={d.over ? '#ef4444' : '#6366f1'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Scope</th>
              <th className="px-4 py-2 font-medium text-right">Budget</th>
              <th className="px-4 py-2 font-medium text-right">Forecast</th>
              <th className="px-4 py-2 font-medium text-right">Δ forecast vs budget</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => {
              const delta = r.forecastUsd - (r.budget?.amountUsd ?? 0);
              const over  = r.budget && delta > 0;
              return (
                <tr key={r.scope.scopeId}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{r.scope.name}</div>
                    <div className="text-xs text-slate-400">{r.scope.scopeType}</div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                    {r.budget ? CURRENCY.format(r.budget.amountUsd) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                    {r.forecastUsd ? CURRENCY.format(r.forecastUsd) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className={clsx(
                    'px-4 py-3 text-right tabular-nums',
                    over ? 'text-red-600' : (r.budget ? 'text-emerald-600' : 'text-slate-300'),
                  )}>
                    {r.budget && r.forecastUsd
                      ? (delta >= 0 ? '+' : '') + CURRENCY.format(delta)
                      : '—'}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && !loading && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-400">
                No active scopes. Create one on the Teams &amp; Scopes page.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={clsx('mt-1 text-2xl font-semibold tabular-nums', color)}>{value}</div>
    </div>
  );
}
