import { useMemo, useState } from 'react';
import { Loader2, X, CheckCircle2, AlertTriangle, Minus } from 'lucide-react';
import clsx from 'clsx';
import {
  commitImport,
  type ImportPreviewResponse, type ImportCommitResponse,
} from '../../api/client';

const CURRENCY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

interface ImportPreviewDrawerProps {
  preview: ImportPreviewResponse;
  /** Called after successful commit so the parent can reload the budgets grid. */
  onCommitted: (result: ImportCommitResponse) => void;
  onClose: () => void;
}

/**
 * Shows parsed CSV rows + errors + a commit button. Commit calls
 * POST /budgets/import/{jobId}/commit, which applies each row as a new
 * budget version in its own DynamoDB transaction.
 */
export default function ImportPreviewDrawer({ preview, onCommitted, onClose }: ImportPreviewDrawerProps) {
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [result,  setResult]  = useState<ImportCommitResponse | null>(null);

  const summary = preview.summary ?? { creates: 0, updates: 0, sames: 0 };
  const errCount = preview.errors?.length ?? 0;
  const canCommit = preview.status === 'PREVIEWED' && (summary.creates + summary.updates) > 0;

  const changeRows = useMemo(
    () => (preview.preview ?? []).filter((r) => r.changeType !== 'same'),
    [preview.preview],
  );
  const sameRows   = useMemo(
    () => (preview.preview ?? []).filter((r) => r.changeType === 'same'),
    [preview.preview],
  );

  async function handleCommit() {
    setBusy(true);
    setError(null);
    try {
      const res = await commitImport(preview.jobId);
      setResult(res);
      onCommitted(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Commit failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-slate-900/40 p-4">
      <div className="mt-10 w-full max-w-4xl max-h-[85vh] overflow-y-auto rounded-lg bg-white shadow-xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white px-5 py-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">CSV import preview</h3>
            <p className="text-xs text-slate-500">Job {preview.jobId} · {preview.status}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Summary KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <Kpi label="New budgets"    value={summary.creates} color="text-emerald-700" />
            <Kpi label="Updates"        value={summary.updates} color="text-indigo-700" />
            <Kpi label="No change"      value={summary.sames}   color="text-slate-500" />
            <Kpi label="Errors"         value={errCount}        color={errCount ? 'text-red-600' : 'text-slate-500'} />
          </div>

          {/* Post-commit banner */}
          {result && (
            <div className={clsx(
              'flex items-center gap-2 rounded-md border p-3 text-sm',
              result.status === 'APPLIED' ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : result.status === 'PARTIAL' ? 'border-amber-200 bg-amber-50 text-amber-900'
                : 'border-red-200 bg-red-50 text-red-800',
            )}>
              {result.status === 'APPLIED' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
              <span>
                <strong>{result.status}</strong> — {result.applied.length} applied, {result.failed.length} failed.
              </span>
            </div>
          )}

          {/* Errors table */}
          {errCount > 0 && (
            <div className="rounded-md border border-red-200 bg-red-50/40">
              <div className="flex items-center gap-2 border-b border-red-100 px-3 py-2 text-sm font-medium text-red-800">
                <AlertTriangle size={13} /> {errCount} validation {errCount === 1 ? 'issue' : 'issues'}
              </div>
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-wide text-red-700">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">Row</th>
                    <th className="px-3 py-1.5 font-medium">Field</th>
                    <th className="px-3 py-1.5 font-medium">Value</th>
                    <th className="px-3 py-1.5 font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-red-100">
                  {preview.errors.map((e, i) => (
                    <tr key={i}>
                      <td className="px-3 py-1.5 text-slate-700 tabular-nums">{e.row}</td>
                      <td className="px-3 py-1.5 text-slate-700">{e.field}</td>
                      <td className="px-3 py-1.5 text-slate-600 max-w-[12rem] truncate">{e.value}</td>
                      <td className="px-3 py-1.5 text-red-700">{e.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Change rows */}
          {changeRows.length > 0 && (
            <div className="rounded-md border border-slate-200 overflow-hidden">
              <div className="border-b border-slate-100 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700">
                {changeRows.length} {changeRows.length === 1 ? 'change' : 'changes'}
              </div>
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">Scope</th>
                    <th className="px-3 py-1.5 font-medium">Period</th>
                    <th className="px-3 py-1.5 font-medium text-right">Current</th>
                    <th className="px-3 py-1.5 font-medium text-right">New</th>
                    <th className="px-3 py-1.5 font-medium text-right">Δ</th>
                    <th className="px-3 py-1.5 font-medium">Type</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {changeRows.map((r, i) => {
                    const delta = r.deltaUsd ?? r.amountUsd;
                    return (
                      <tr key={i}>
                        <td className="px-3 py-1.5">
                          <div className="font-medium text-slate-800">{r.scopeName || '—'}</div>
                          <div className="text-[11px] text-slate-400">{r.scopeId}</div>
                        </td>
                        <td className="px-3 py-1.5 text-slate-700 tabular-nums">{r.period}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">
                          {r.currentUsd == null ? <span className="text-slate-300">—</span> : CURRENCY.format(r.currentUsd)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-slate-900">
                          {CURRENCY.format(r.amountUsd)}
                        </td>
                        <td className={clsx(
                          'px-3 py-1.5 text-right tabular-nums',
                          delta > 0 ? 'text-red-600' : delta < 0 ? 'text-emerald-600' : 'text-slate-400',
                        )}>
                          {delta > 0 ? '+' : ''}{CURRENCY.format(delta)}
                        </td>
                        <td className="px-3 py-1.5">
                          <span className={clsx(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1',
                            r.changeType === 'create'
                              ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                              : 'bg-indigo-50 text-indigo-700 ring-indigo-200',
                          )}>
                            {r.changeType}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Unchanged rows (collapsed) */}
          {sameRows.length > 0 && (
            <details className="rounded-md border border-slate-200 bg-slate-50/50 px-3 py-2 text-sm text-slate-600">
              <summary className="cursor-pointer inline-flex items-center gap-1.5">
                <Minus size={12} /> {sameRows.length} rows match current budgets (no change)
              </summary>
              <ul className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-500">
                {sameRows.map((r, i) => (
                  <li key={i}>{r.scopeName} · {r.period} · {CURRENCY.format(r.amountUsd)}</li>
                ))}
              </ul>
            </details>
          )}

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        {/* Action bar */}
        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-slate-100 bg-white px-5 py-3">
          <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-700">
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && (
            <button
              onClick={handleCommit}
              disabled={!canCommit || busy}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium text-white',
                canCommit && !busy
                  ? 'bg-indigo-600 hover:bg-indigo-700'
                  : 'bg-slate-300 cursor-not-allowed',
              )}
            >
              {busy && <Loader2 size={13} className="animate-spin" />}
              {preview.status === 'NO_CHANGES'
                ? 'Nothing to commit'
                : `Commit ${summary.creates + summary.updates} change${summary.creates + summary.updates === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={clsx('mt-0.5 text-lg font-semibold tabular-nums', color)}>{value}</div>
    </div>
  );
}
