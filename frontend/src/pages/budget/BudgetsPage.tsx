import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Save, History, Pencil, X } from 'lucide-react';
import clsx from 'clsx';
import {
  listScopes, getCurrentBudget, setBudget, getBudgetHistory,
  type Scope, type BudgetVersion,
} from '../../api/client';
import { useRole } from '../../auth/useRole';

const CURRENCY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export default function BudgetsPage() {
  const { isAdmin, loading: roleLoading } = useRole();
  // Three previous months + current + two next, formatted YYYY-MM.
  const displayPeriods = useMemo(() => {
    const now = new Date();
    const out: string[] = [];
    for (let offset = -3; offset <= 2; offset++) {
      const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return out;
  }, []);

  const [scopes, setScopes] = useState<Scope[]>([]);
  const [budgets, setBudgets] = useState<Record<string, BudgetVersion | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyScope, setHistoryScope] = useState<Scope | null>(null);
  const [historyVersions, setHistoryVersions] = useState<BudgetVersion[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await listScopes('active');
      setScopes(resp.scopes);

      const entries = await Promise.all(
        resp.scopes.flatMap((s) => displayPeriods.map(async (p) => {
          const b = await getCurrentBudget(s.scopeId, p);
          return [`${s.scopeId}|${p}`, b] as const;
        })),
      );
      const next: Record<string, BudgetVersion | null> = {};
      for (const [k, v] of entries) next[k] = v;
      setBudgets(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load budgets');
    } finally {
      setLoading(false);
    }
  }, [displayPeriods]);

  useEffect(() => { load(); }, [load]);

  function startEdit(scopeId: string, period: string, current: BudgetVersion | null) {
    setEditKey(`${scopeId}|${period}`);
    setEditValue(current ? String(Math.round(current.amountUsd)) : '');
  }

  async function commitEdit(scopeId: string, period: string) {
    const num = parseFloat(editValue.replace(/,/g, ''));
    if (Number.isNaN(num) || num < 0) { setError('Enter a non-negative number'); return; }
    const key = `${scopeId}|${period}`;
    setBusy(key);
    try {
      const newVer = await setBudget(scopeId, period, { amountUsd: num });
      setBudgets((prev) => ({ ...prev, [key]: newVer }));
      setEditKey(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(null);
    }
  }

  async function openHistory(scope: Scope) {
    setHistoryOpen(true);
    setHistoryScope(scope);
    setHistoryLoading(true);
    try {
      const resp = await getBudgetHistory(scope.scopeId);
      setHistoryVersions(resp.versions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'History load failed');
      setHistoryVersions([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  if (roleLoading) return <div className="p-6 text-sm text-slate-500"><Loader2 size={14} className="inline animate-spin" /> Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-500">
          {scopes.length} scopes × {displayPeriods.length} periods
          {!isAdmin && <span className="ml-2 text-xs text-amber-600">(read-only — admin required to edit)</span>}
        </div>
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="sticky left-0 bg-slate-50 px-4 py-2 font-medium">Scope</th>
              {displayPeriods.map((p) => (
                <th key={p} className="px-4 py-2 font-medium text-right">{p}</th>
              ))}
              <th className="px-4 py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && (
              <tr><td colSpan={displayPeriods.length + 2} className="px-4 py-8 text-center text-slate-400">
                <Loader2 size={16} className="inline animate-spin" /> Loading budgets…
              </td></tr>
            )}
            {!loading && scopes.length === 0 && (
              <tr><td colSpan={displayPeriods.length + 2} className="px-4 py-8 text-center text-slate-400">
                No active scopes. Create one on the Teams &amp; Scopes page.
              </td></tr>
            )}
            {!loading && scopes.map((s) => (
              <tr key={s.scopeId}>
                <td className="sticky left-0 bg-white px-4 py-3 whitespace-nowrap">
                  <div className="font-medium text-slate-900">{s.name}</div>
                  <div className="text-xs text-slate-400">{s.scopeType}</div>
                </td>
                {displayPeriods.map((p) => {
                  const key = `${s.scopeId}|${p}`;
                  const bud = budgets[key] ?? null;
                  const editing = editKey === key;
                  return (
                    <td key={p} className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                      {editing ? (
                        <span className="inline-flex items-center gap-1">
                          <span className="text-slate-400">$</span>
                          <input
                            autoFocus
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitEdit(s.scopeId, p);
                              if (e.key === 'Escape') setEditKey(null);
                            }}
                            className="w-28 rounded border border-indigo-300 px-2 py-0.5 text-sm outline-none focus:border-indigo-500 text-right"
                          />
                          <button
                            onClick={() => commitEdit(s.scopeId, p)}
                            disabled={busy === key}
                            className="text-indigo-600 hover:text-indigo-800"
                            title="Save"
                          >
                            {busy === key ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                          </button>
                          <button onClick={() => setEditKey(null)} className="text-slate-400 hover:text-slate-600" title="Cancel">
                            <X size={13} />
                          </button>
                        </span>
                      ) : (
                        <span className={clsx('group inline-flex items-center gap-1', isAdmin && 'cursor-pointer')}>
                          <span className={clsx(bud ? 'text-slate-700' : 'text-slate-300')}>
                            {bud ? CURRENCY.format(bud.amountUsd) : '—'}
                          </span>
                          {isAdmin && (
                            <button
                              onClick={() => startEdit(s.scopeId, p, bud)}
                              className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-indigo-600 transition-opacity"
                              title={bud ? 'Edit budget' : 'Set budget'}
                            >
                              <Pencil size={12} />
                            </button>
                          )}
                        </span>
                      )}
                    </td>
                  );
                })}
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => openHistory(s)}
                    className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-indigo-600"
                    title="Version history"
                  >
                    <History size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {historyOpen && historyScope && (
        <HistoryDrawer
          scope={historyScope}
          versions={historyVersions}
          loading={historyLoading}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      <p className="text-xs text-slate-500">
        Each edit creates a new budget version; prior versions stay visible via the history icon.
        Numbers are unblended USD.
      </p>
    </div>
  );
}

function HistoryDrawer({
  scope, versions, loading, onClose,
}: {
  scope:    Scope;
  versions: BudgetVersion[];
  loading:  boolean;
  onClose:  () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-slate-900/40 p-4">
      <div className="mt-16 w-full max-w-2xl rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-900">
            Budget history — {scope.name}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="p-6 text-sm text-slate-500"><Loader2 size={14} className="inline animate-spin" /> Loading…</div>
          ) : versions.length === 0 ? (
            <div className="p-6 text-sm text-slate-400">No budget versions yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Period</th>
                  <th className="px-4 py-2">Version</th>
                  <th className="px-4 py-2 text-right">Amount</th>
                  <th className="px-4 py-2">Created</th>
                  <th className="px-4 py-2">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {versions.map((v) => (
                  <tr key={`${v.period}-${v.version}`} className={v.isCurrent ? 'bg-indigo-50/40' : ''}>
                    <td className="px-4 py-2 text-slate-700">{v.period}</td>
                    <td className="px-4 py-2 text-slate-600">v{v.version}{v.isCurrent && <span className="ml-1 text-[10px] text-indigo-600">current</span>}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{CURRENCY.format(v.amountUsd)}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">{v.createdAt?.slice(0, 10) || '—'}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">{(v.createdBy || '').slice(0, 8)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
