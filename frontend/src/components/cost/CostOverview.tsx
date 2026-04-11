import { useState, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import { TrendingUp, TrendingDown, Loader2, RefreshCw, AlertCircle } from 'lucide-react';
import { getMonthlySpend, type MonthlySpend } from '../../api/client';
import { useSetHeaderActionsDynamic } from '../layout/HeaderActions';

// ── Formatters ────────────────────────────────────────────────────────────────

function fmt(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000)     return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function shortMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split('-');
  return new Date(Number(year), Number(month) - 1)
    .toLocaleString('default', { month: 'short', year: '2-digit' });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: {
  active?:   boolean;
  payload?:  Array<{ value?: number; payload?: { prev_cost?: number } }>;
  label?:    string | number;
}) {
  if (!active || !payload?.length) return null;
  const value  = payload[0]?.value as number;
  const prev   = payload[0]?.payload?.prev_cost as number | undefined;
  const change = prev != null && prev > 0 ? ((value - prev) / prev) * 100 : null;
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm shadow-lg">
      <p className="mb-1 text-xs font-semibold text-zinc-500">{String(label ?? '')}</p>
      <p className="text-[15px] font-bold tabular-nums text-zinc-900">{fmt(value)}</p>
      {change != null && (
        <p className={`mt-0.5 text-xs ${change >= 0 ? 'text-red-600' : 'text-emerald-600'}`}>
          {change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(1)}% vs prior month
        </p>
      )}
    </div>
  );
}

function StatCard({
  label, value, sub, trend,
}: {
  label: string;
  value: string;
  sub?:  string;
  trend?: 'up' | 'down' | null;
}) {
  return (
    <div className="rounded-xl border border-zinc-200/80 bg-white px-5 py-4 shadow-sm">
      <p className="text-[10.5px] font-semibold uppercase tracking-widest text-zinc-400">{label}</p>
      <div className="mt-1.5 flex items-end gap-2">
        <p className="text-[1.375rem] font-semibold tabular-nums leading-none tracking-tight text-zinc-900">
          {value}
        </p>
        {trend === 'up'   && <TrendingUp  size={15} className="mb-0.5 text-red-500" />}
        {trend === 'down' && <TrendingDown size={15} className="mb-0.5 text-emerald-600" />}
      </div>
      {sub && <p className="mt-1 text-[11px] text-zinc-400">{sub}</p>}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function CostOverview() {
  const [data,    setData]    = useState<MonthlySpend[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [hint,    setHint]    = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    setHint(null);
    try {
      const resp = await getMonthlySpend();
      setData(resp.monthly_spend);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('503') || msg.includes('not available')) {
        setHint('CUR data not available yet. Run the Glue crawler after the first CUR delivery (Day 2).');
      } else {
        setError(msg || 'Failed to load overview data.');
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // Inject Refresh button into PageHeader's right action slot
  useSetHeaderActionsDynamic(
    <button
      type="button"
      onClick={load}
      disabled={loading}
      className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-[0.3125rem] text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
      Refresh
    </button>,
    [loading],
  );

  // ── Derived values ─────────────────────────────────────────────────────────
  const chartData = data.map((d, i) => ({
    ...d,
    label:     shortMonth(d.year_month),
    prev_cost: i > 0 ? data[i - 1].total_cost : undefined,
  }));

  const current   = data.at(-1);
  const previous  = data.at(-2);
  const yoyMonth  = data.length >= 13 ? data[data.length - 13] : null;
  const total12m  = data.slice(-12).reduce((s, d) => s + d.total_cost, 0);
  const momChange = current && previous && previous.total_cost > 0
    ? ((current.total_cost - previous.total_cost) / previous.total_cost) * 100 : null;
  const yoyChange = current && yoyMonth && yoyMonth.total_cost > 0
    ? ((current.total_cost - yoyMonth.total_cost) / yoyMonth.total_cost) * 100 : null;

  const barFill = (i: number) => i === chartData.length - 1 ? '#0284c7' : '#cbd5e1';

  // ── States ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex min-h-[18rem] items-center justify-center">
        <Loader2 size={22} className="animate-spin text-zinc-300" />
      </div>
    );
  }

  if (hint) {
    return (
      <div className="flex gap-3 rounded-xl border border-amber-200/80 bg-amber-50 px-5 py-4 text-sm text-amber-900">
        <AlertCircle size={17} className="mt-0.5 shrink-0 text-amber-500" />
        <div>
          <p className="font-semibold">Waiting for CUR data</p>
          <p className="mt-1 text-amber-800/90">{hint}</p>
          <code className="mt-2 block rounded bg-amber-100 px-2 py-1 font-mono text-xs">
            aws glue start-crawler --name kostops-cur-crawler
          </code>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-100 bg-red-50 px-5 py-4 text-sm text-red-700">
        {error}
      </div>
    );
  }

  if (!data.length) return null;

  return (
    <div className="space-y-5">

      {/* ── Stat cards ──────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="This month"
          value={current ? fmt(current.total_cost) : '—'}
          sub={current?.year_month}
          trend={momChange != null ? (momChange >= 0 ? 'up' : 'down') : null}
        />
        <StatCard
          label="MoM change"
          value={momChange != null ? `${momChange >= 0 ? '+' : ''}${momChange.toFixed(1)}%` : '—'}
          sub={previous ? `vs ${shortMonth(previous.year_month)}` : undefined}
        />
        <StatCard
          label="YoY change"
          value={yoyChange != null ? `${yoyChange >= 0 ? '+' : ''}${yoyChange.toFixed(1)}%` : '—'}
          sub={yoyMonth ? `vs ${shortMonth(yoyMonth.year_month)}` : 'Need 13 months of data'}
        />
        <StatCard
          label="Last 12 months"
          value={fmt(total12m)}
          sub="Total unblended spend"
        />
      </div>

      {/* ── Bar chart ───────────────────────────────────────────────── */}
      <div className="rounded-xl border border-zinc-200/80 bg-white px-5 pb-4 pt-5 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-[13px] font-semibold text-zinc-800">
            Monthly spend
          </p>
          <p className="text-[11px] text-zinc-400">
            {data.at(0)?.year_month} – {data.at(-1)?.year_month}
          </p>
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={chartData} barCategoryGap="32%">
            <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: '#a1a1aa' }}
              axisLine={false} tickLine={false}
            />
            <YAxis
              tickFormatter={v => fmt(v)}
              tick={{ fontSize: 11, fill: '#a1a1aa' }}
              axisLine={false} tickLine={false}
              width={60}
            />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: '#f9fafb' }} />
            <ReferenceLine
              y={total12m / Math.min(data.length, 12)}
              stroke="#e4e4e7"
              strokeDasharray="4 4"
              label={{ value: 'avg', fontSize: 10, fill: '#a1a1aa', position: 'right' }}
            />
            <Bar dataKey="total_cost" radius={[3, 3, 0, 0]}>
              {chartData.map((_, i) => (
                <Cell key={i} fill={barFill(i)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* ── Detail table ─────────────────────────────────────────────── */}
      <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white shadow-sm">
        <div className="border-b border-zinc-100 px-5 py-3">
          <p className="text-[13px] font-semibold text-zinc-800">Monthly breakdown</p>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 bg-zinc-50/60">
              <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                Period
              </th>
              <th className="px-5 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                Spend
              </th>
              <th className="px-5 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                MoM
              </th>
            </tr>
          </thead>
          <tbody>
            {[...chartData].reverse().map((row, i) => {
              const change = row.prev_cost != null && row.prev_cost > 0
                ? ((row.total_cost - row.prev_cost) / row.prev_cost) * 100 : null;
              const isCurrent = i === 0;
              return (
                <tr
                  key={row.year_month}
                  className={`border-b border-zinc-50 last:border-0 transition-colors ${
                    isCurrent ? 'bg-brand-50/40' : 'hover:bg-zinc-50/60'
                  }`}
                >
                  <td className="px-5 py-2.5 text-[13px] font-medium text-zinc-700">
                    {row.year_month}
                    {isCurrent && (
                      <span className="ml-2 rounded bg-brand-100 px-1.5 py-0.5 text-[10px] font-semibold text-brand-700">
                        current
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-2.5 text-right font-mono text-[13px] tabular-nums text-zinc-900">
                    {fmt(row.total_cost)}
                  </td>
                  <td className="px-5 py-2.5 text-right text-[13px] tabular-nums">
                    {change != null ? (
                      <span className={change >= 0 ? 'text-red-600' : 'text-emerald-600'}>
                        {change >= 0 ? '+' : ''}{change.toFixed(1)}%
                      </span>
                    ) : (
                      <span className="text-zinc-300">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

    </div>
  );
}
