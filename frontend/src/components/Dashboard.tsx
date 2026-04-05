import { useState, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import { LayoutDashboard, TrendingUp, TrendingDown, Loader2, RefreshCw, AlertCircle } from 'lucide-react';
import { getMonthlySpend, type MonthlySpend } from '../api/client';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000)     return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function shortMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split('-');
  const date = new Date(Number(year), Number(month) - 1);
  return date.toLocaleString('default', { month: 'short', year: '2-digit' });
}

// Custom tooltip for the bar chart
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const value  = payload[0]?.value as number;
  const prev   = payload[0]?.payload?.prev_cost as number | undefined;
  const change = prev != null && prev > 0 ? ((value - prev) / prev) * 100 : null;

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-lg px-4 py-3 text-sm">
      <p className="font-semibold text-gray-800 mb-1">{label}</p>
      <p className="text-brand-600 font-bold text-base">{fmt(value)}</p>
      {change != null && (
        <p className={change >= 0 ? 'text-red-500' : 'text-green-500'}>
          {change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(1)}% vs prev month
        </p>
      )}
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({
  label, value, sub, trend,
}: {
  label: string;
  value: string;
  sub?:  string;
  trend?: 'up' | 'down' | null;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 px-5 py-4">
      <p className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-1">{label}</p>
      <div className="flex items-end gap-2">
        <p className="text-2xl font-bold text-gray-900">{value}</p>
        {trend === 'up'   && <TrendingUp   size={18} className="text-red-500   mb-0.5" />}
        {trend === 'down' && <TrendingDown size={18} className="text-green-500 mb-0.5" />}
      </div>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Dashboard() {
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
    } catch (err: any) {
      const detail = err?.message ?? '';
      // 503 means Glue table not ready yet — show a helpful hint instead of a red error
      if (detail.includes('503') || detail.includes('not available')) {
        setHint('CUR data not available yet. Run the Glue crawler after the first CUR delivery arrives (Day 2).');
      } else {
        setError(detail || 'Failed to load dashboard data');
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // Enrich data with prev_cost for tooltip delta calculation
  const chartData = data.map((d, i) => ({
    ...d,
    label:     shortMonth(d.year_month),
    prev_cost: i > 0 ? data[i - 1].total_cost : undefined,
  }));

  // Derived stats
  const current  = data.at(-1);
  const previous = data.at(-2);
  const yoyMonth = data.length >= 13 ? data[data.length - 13] : null;
  const total12m = data.slice(-12).reduce((s, d) => s + d.total_cost, 0);
  const momChange = current && previous && previous.total_cost > 0
    ? ((current.total_cost - previous.total_cost) / previous.total_cost) * 100
    : null;
  const yoyChange = current && yoyMonth && yoyMonth.total_cost > 0
    ? ((current.total_cost - yoyMonth.total_cost) / yoyMonth.total_cost) * 100
    : null;

  // Colour bars: current month = brand blue, others = slate
  const barColour = (index: number) =>
    index === chartData.length - 1 ? '#0284c7' : '#94a3b8';

  return (
    <div className="flex flex-col h-full bg-gray-50">

      {/* ── Header ───────────────────────────────────────────────────────────── */}
      <header className="flex-shrink-0 px-6 py-4 bg-white border-b border-gray-100">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <LayoutDashboard size={18} className="text-brand-500" />
              <h1 className="text-base font-semibold text-gray-900">Dashboard</h1>
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              Monthly AWS spend — last 13 months
            </p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-600
                       border border-gray-200 rounded-lg hover:bg-gray-50
                       disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-6 py-5 space-y-5">

        {/* ── Loading ───────────────────────────────────────────────────────── */}
        {loading && (
          <div className="flex items-center justify-center h-64">
            <Loader2 size={24} className="animate-spin text-gray-400" />
          </div>
        )}

        {/* ── CUR not ready yet ─────────────────────────────────────────────── */}
        {!loading && hint && (
          <div className="flex items-start gap-3 bg-amber-50 border border-amber-200
                          rounded-xl px-5 py-4 text-sm text-amber-800">
            <AlertCircle size={18} className="flex-shrink-0 mt-0.5 text-amber-500" />
            <div>
              <p className="font-semibold mb-1">Waiting for CUR data</p>
              <p>{hint}</p>
              <code className="block mt-2 text-xs bg-amber-100 rounded px-2 py-1 font-mono">
                aws glue start-crawler --name kostops-cur-crawler
              </code>
            </div>
          </div>
        )}

        {/* ── Error ─────────────────────────────────────────────────────────── */}
        {!loading && error && (
          <div className="rounded-xl bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-600">
            {error}
          </div>
        )}

        {/* ── Stats ─────────────────────────────────────────────────────────── */}
        {!loading && data.length > 0 && (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
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
                sub="Total spend"
              />
            </div>

            {/* ── Bar chart ──────────────────────────────────────────────────── */}
            <div className="bg-white rounded-xl border border-gray-200 px-5 pt-5 pb-3">
              <p className="text-sm font-semibold text-gray-800 mb-4">
                Monthly spend — {data.at(0)?.year_month} to {data.at(-1)?.year_month}
              </p>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={chartData} barCategoryGap="30%">
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: '#94a3b8' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tickFormatter={fmt}
                    tick={{ fontSize: 11, fill: '#94a3b8' }}
                    axisLine={false}
                    tickLine={false}
                    width={60}
                  />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: '#f8fafc' }} />
                  {/* Average reference line */}
                  <ReferenceLine
                    y={total12m / Math.min(data.length, 12)}
                    stroke="#e2e8f0"
                    strokeDasharray="4 4"
                    label={{ value: 'avg', fontSize: 10, fill: '#cbd5e1', position: 'right' }}
                  />
                  <Bar dataKey="total_cost" radius={[4, 4, 0, 0]}>
                    {chartData.map((_, i) => (
                      <Cell key={i} fill={barColour(i)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* ── Monthly table ──────────────────────────────────────────────── */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Month</th>
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Spend</th>
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">MoM</th>
                  </tr>
                </thead>
                <tbody>
                  {[...chartData].reverse().map((row, i) => {
                    const change = row.prev_cost != null && row.prev_cost > 0
                      ? ((row.total_cost - row.prev_cost) / row.prev_cost) * 100
                      : null;
                    const isCurrentMonth = i === 0;
                    return (
                      <tr key={row.year_month}
                          className={`border-b border-gray-50 last:border-0 ${isCurrentMonth ? 'bg-brand-50/40' : 'hover:bg-gray-50'}`}>
                        <td className="px-5 py-2.5 font-medium text-gray-800">
                          {row.year_month}
                          {isCurrentMonth && (
                            <span className="ml-2 text-xs text-brand-600 font-semibold">current</span>
                          )}
                        </td>
                        <td className="px-5 py-2.5 text-right font-mono text-gray-900">
                          {fmt(row.total_cost)}
                        </td>
                        <td className="px-5 py-2.5 text-right">
                          {change != null ? (
                            <span className={change >= 0 ? 'text-red-500' : 'text-green-600'}>
                              {change >= 0 ? '+' : ''}{change.toFixed(1)}%
                            </span>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
