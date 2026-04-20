import { useEffect, useState } from 'react';
import { Loader2, X, AlertTriangle, PlayCircle } from 'lucide-react';
import clsx from 'clsx';
import {
  previewAllocation,
  type AllocationRule, type AllocationPreviewResponse,
} from '../../api/client';

const CURRENCY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function lastFullPeriod(): string {
  const d = new Date();
  // Prior month YYYY-MM — a full period that has CUR data.
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

interface AllocationPreviewDrawerProps {
  rule:     AllocationRule;
  onClose:  () => void;
}

export default function AllocationPreviewDrawer({ rule, onClose }: AllocationPreviewDrawerProps) {
  const [period, setPeriod]     = useState(lastFullPeriod());
  const [result, setResult]     = useState<AllocationPreviewResponse | null>(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await previewAllocation(rule.ruleId, period);
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setLoading(false);
    }
  }

  // Auto-run on open with the default period.
  useEffect(() => { run(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [rule.ruleId]);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-slate-900/40 p-4">
      <div className="mt-10 w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-lg bg-white shadow-xl">
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-100 bg-white px-5 py-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Allocation preview</h3>
            <p className="text-xs text-slate-500">Source account {rule.sourceAccountId} · rule {rule.ruleId}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="flex items-end gap-3">
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Period</span>
              <input
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                placeholder="2026-03"
                className="mt-1 w-32 rounded-md border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-indigo-400"
              />
            </label>
            <button
              onClick={run}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {loading ? <Loader2 size={13} className="animate-spin" /> : <PlayCircle size={13} />}
              Re-run
            </button>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <AlertTriangle size={14} /> {error}
            </div>
          )}

          {result && (
            <>
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
                <div className="text-[11px] uppercase tracking-wide text-slate-500">Source total for {result.period}</div>
                <div className="mt-0.5 text-2xl font-semibold tabular-nums text-slate-900">
                  {CURRENCY.format(result.sourceTotalUsd)}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Rule type: {result.ruleType}
                </div>
              </div>

              {result.projected.length === 0 ? (
                <div className="rounded-md border border-slate-200 p-4 text-sm text-slate-500">
                  No splits defined on this rule.
                </div>
              ) : (
                <div className="rounded-md border border-slate-200 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-3 py-1.5 font-medium">Target scope</th>
                        <th className="px-3 py-1.5 font-medium text-right">Pct</th>
                        <th className="px-3 py-1.5 font-medium text-right">Projected $$</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {result.projected.map((p, i) => (
                        <tr key={i}>
                          <td className="px-3 py-2">
                            <div className="font-medium text-slate-800">{p.targetScopeName || '—'}</div>
                            <div className="text-[11px] text-slate-400">{p.targetScopeId}</div>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-700">{p.pct.toFixed(2)}%</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-900">
                            {CURRENCY.format(p.projectedUsd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-xs text-slate-500">
                This is a projection only — no budgets or actuals are modified.
                Variance dashboards will incorporate these splits once the weekly
                ScopeActuals refresh job lands.
              </p>
            </>
          )}
        </div>

        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-slate-100 bg-white px-5 py-3">
          <button onClick={onClose} className={clsx('text-sm text-slate-500 hover:text-slate-700')}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
