import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus, RefreshCw, Loader2, Archive, Pencil, X, Split, PlayCircle, Trash2,
} from 'lucide-react';
import clsx from 'clsx';
import {
  listAllocations, createAllocation, updateAllocation, archiveAllocation,
  listScopes, listVisibilityFilters,
  type AllocationRule, type AllocationRuleInput, type AllocationSplit,
  type Scope, type VisibilityFilters,
} from '../../api/client';
import { useRole } from '../../auth/useRole';
import AllocationPreviewDrawer from './AllocationPreviewDrawer';

const EMPTY_INPUT: AllocationRuleInput = {
  sourceAccountId: '',
  ruleType:        'PERCENTAGE',
  splits:          [],
  effectiveFrom:   '',
  effectiveTo:     '',
  note:            '',
};

export default function AllocationsPage() {
  const { isAdmin, loading: roleLoading } = useRole();
  const [rules,    setRules]    = useState<AllocationRule[]>([]);
  const [scopes,   setScopes]   = useState<Scope[]>([]);
  const [filters,  setFilters]  = useState<VisibilityFilters | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);
  const [busy,     setBusy]     = useState<string | null>(null);

  const [editOpen,    setEditOpen]    = useState(false);
  const [editTarget,  setEditTarget]  = useState<AllocationRule | null>(null);
  const [editInput,   setEditInput]   = useState<AllocationRuleInput>(EMPTY_INPUT);

  const [previewRule, setPreviewRule] = useState<AllocationRule | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rs, ss] = await Promise.all([
        listAllocations(),
        listScopes('active'),
      ]);
      setRules(rs.rules);
      setScopes(ss.scopes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load allocations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { listVisibilityFilters().then(setFilters).catch(() => setFilters(null)); }, []);

  const scopeNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of scopes) m.set(s.scopeId, s.name);
    return m;
  }, [scopes]);

  const accountNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of filters?.accounts ?? []) m.set(a.id, a.name);
    return m;
  }, [filters]);

  function openCreate() {
    setEditTarget(null);
    setEditInput({ ...EMPTY_INPUT, splits: [{ targetScopeId: '', pct: 100 }] });
    setEditOpen(true);
  }

  function openEdit(rule: AllocationRule) {
    setEditTarget(rule);
    setEditInput({
      sourceAccountId: rule.sourceAccountId,
      ruleType:        rule.ruleType,
      splits:          (rule.splits || []).map((s) => ({ targetScopeId: s.targetScopeId, pct: s.pct })),
      effectiveFrom:   rule.effectiveFrom ?? '',
      effectiveTo:     rule.effectiveTo ?? '',
      note:            rule.note ?? '',
    });
    setEditOpen(true);
  }

  function closeEdit() { setEditOpen(false); setEditTarget(null); }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const pctSum = editInput.splits.reduce((s, x) => s + (Number(x.pct) || 0), 0);
    if (Math.abs(pctSum - 100) > 0.01) {
      setError(`Splits must sum to 100 (currently ${pctSum.toFixed(2)})`);
      return;
    }
    if (editInput.splits.some((s) => !s.targetScopeId)) {
      setError('Every split must name a target scope.');
      return;
    }
    setBusy('save');
    try {
      if (editTarget) {
        await updateAllocation(editTarget.ruleId, editInput);
      } else {
        if (!/^\d{12}$/.test(editInput.sourceAccountId)) {
          setError('Source account must be a 12-digit AWS account id.');
          setBusy(null);
          return;
        }
        await createAllocation(editInput);
      }
      closeEdit();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(null);
    }
  }

  async function handleArchive(rule: AllocationRule) {
    if (!confirm(`Archive rule for ${rule.sourceAccountId}? Past cost history is retained.`)) return;
    setBusy(rule.ruleId);
    try {
      await archiveAllocation(rule.ruleId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Archive failed');
    } finally {
      setBusy(null);
    }
  }

  if (roleLoading) {
    return <div className="p-6 text-sm text-slate-500"><Loader2 size={14} className="inline animate-spin" /> Checking permissions…</div>;
  }

  if (!isAdmin) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        Allocation rules are admin-only. You can still ask the Budget Agent in chat
        to <em>explain</em> how a scope includes an account (try: <code>explain why scope X includes account Y</code>).
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm text-slate-500">
          {rules.length} active {rules.length === 1 ? 'rule' : 'rules'} across {new Set(rules.map((r) => r.sourceAccountId)).size} source account(s)
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            <RefreshCw size={14} /> Refresh
          </button>
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
          >
            <Plus size={14} /> New rule
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Source account</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Splits</th>
              <th className="px-4 py-2 font-medium">Effective</th>
              <th className="px-4 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                <Loader2 size={16} className="inline animate-spin" /> Loading rules…
              </td></tr>
            )}
            {!loading && rules.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                No allocation rules yet. Create one to split a shared account across target scopes.
              </td></tr>
            )}
            {!loading && rules.map((r) => (
              <tr key={r.ruleId}>
                <td className="px-4 py-3">
                  <div className="font-mono text-slate-900">{r.sourceAccountId}</div>
                  <div className="text-xs text-slate-400">{accountNameById.get(r.sourceAccountId) || '—'}</div>
                </td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-2 py-0.5 text-xs font-medium ring-1 ring-slate-200 text-slate-700">
                    <Split size={11} /> {r.ruleType}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {(r.splits || []).map((s, i) => (
                      <span
                        key={i}
                        className="inline-flex items-center gap-1 rounded bg-indigo-50 px-2 py-0.5 text-[11px] text-indigo-800 ring-1 ring-indigo-200"
                      >
                        <span className="max-w-[12rem] truncate">{scopeNameById.get(s.targetScopeId) || s.targetScopeId}</span>
                        <span className="tabular-nums">{s.pct.toFixed(0)}%</span>
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 text-xs text-slate-600">
                  {r.effectiveFrom || '—'}{r.effectiveTo ? ` → ${r.effectiveTo}` : ''}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-2">
                    <button
                      onClick={() => setPreviewRule(r)}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                      title="Preview for a period"
                    >
                      <PlayCircle size={12} /> Preview
                    </button>
                    <button
                      onClick={() => openEdit(r)}
                      disabled={busy === r.ruleId}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      <Pencil size={12} /> Edit
                    </button>
                    <button
                      onClick={() => handleArchive(r)}
                      disabled={busy === r.ruleId}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      <Archive size={12} /> Archive
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editOpen && (
        <AllocationEditor
          input={editInput}
          setInput={setEditInput}
          onSave={handleSave}
          onClose={closeEdit}
          busy={busy === 'save'}
          scopes={scopes}
          filters={filters}
          isEdit={!!editTarget}
        />
      )}

      {previewRule && (
        <AllocationPreviewDrawer rule={previewRule} onClose={() => setPreviewRule(null)} />
      )}

      <p className="text-xs text-slate-500">
        Allocation rules split a shared account's cost across target scopes.
        PERCENTAGE splits must sum to 100. Use Preview against a recent full
        month to see the projected $$ per target before committing.
      </p>
    </div>
  );
}

function AllocationEditor({
  input, setInput, onSave, onClose, busy, scopes, filters, isEdit,
}: {
  input:    AllocationRuleInput;
  setInput: (input: AllocationRuleInput) => void;
  onSave:   (e: React.FormEvent) => void;
  onClose:  () => void;
  busy:     boolean;
  scopes:   Scope[];
  filters:  VisibilityFilters | null;
  isEdit:   boolean;
}) {
  const accountOptions = useMemo(
    () => (filters?.accounts ?? []).map((a) => ({ id: a.id, name: a.name })),
    [filters],
  );

  const pctSum = input.splits.reduce((s, x) => s + (Number(x.pct) || 0), 0);

  function updateSplit(i: number, patch: Partial<AllocationSplit>) {
    const next = input.splits.map((s, idx) => idx === i ? { ...s, ...patch } : s);
    setInput({ ...input, splits: next });
  }

  function addSplit() {
    setInput({ ...input, splits: [...input.splits, { targetScopeId: '', pct: 0 }] });
  }

  function removeSplit(i: number) {
    setInput({ ...input, splits: input.splits.filter((_, idx) => idx !== i) });
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4">
      <form
        onSubmit={onSave}
        className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-lg bg-white shadow-xl"
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-100 bg-white px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-900">
            {isEdit ? 'Edit allocation rule' : 'New allocation rule'}
          </h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {isEdit ? (
            <div className="text-xs text-slate-500">
              Source account: <span className="font-mono text-slate-900">{input.sourceAccountId}</span>
            </div>
          ) : (
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Source account</span>
              <select
                value={input.sourceAccountId}
                onChange={(e) => setInput({ ...input, sourceAccountId: e.target.value })}
                required
                className="mt-1 block w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400"
              >
                <option value="">— Select an account —</option>
                {accountOptions.map((a) => (
                  <option key={a.id} value={a.id}>{a.id} {a.name ? `— ${a.name}` : ''}</option>
                ))}
              </select>
            </label>
          )}

          <div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                Splits
              </span>
              <span className={clsx(
                'text-[11px] tabular-nums',
                Math.abs(pctSum - 100) < 0.01 ? 'text-emerald-600' : 'text-amber-600',
              )}>
                Sum: {pctSum.toFixed(2)}%
              </span>
            </div>
            <div className="mt-2 space-y-2">
              {input.splits.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    value={s.targetScopeId}
                    onChange={(e) => updateSplit(i, { targetScopeId: e.target.value })}
                    className="flex-1 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-indigo-400"
                  >
                    <option value="">— Target scope —</option>
                    {scopes.map((sc) => (
                      <option key={sc.scopeId} value={sc.scopeId}>{sc.name} ({sc.scopeType})</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    value={s.pct}
                    onChange={(e) => updateSplit(i, { pct: parseFloat(e.target.value) || 0 })}
                    className="w-24 rounded-md border border-slate-200 px-3 py-1.5 text-sm tabular-nums text-right outline-none focus:border-indigo-400"
                  />
                  <span className="text-sm text-slate-400">%</span>
                  <button
                    type="button"
                    onClick={() => removeSplit(i)}
                    className="text-slate-400 hover:text-red-500"
                    aria-label="Remove split"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addSplit}
              className="mt-2 inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800"
            >
              <Plus size={12} /> Add split
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Effective from</span>
              <input
                type="date"
                value={input.effectiveFrom}
                onChange={(e) => setInput({ ...input, effectiveFrom: e.target.value })}
                className="mt-1 w-full rounded-md border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-indigo-400"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Effective to (optional)</span>
              <input
                type="date"
                value={input.effectiveTo}
                onChange={(e) => setInput({ ...input, effectiveTo: e.target.value })}
                className="mt-1 w-full rounded-md border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-indigo-400"
              />
            </label>
          </div>

          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Note</span>
            <input
              value={input.note}
              onChange={(e) => setInput({ ...input, note: e.target.value })}
              maxLength={512}
              placeholder="Shared networking account — Q3 2026"
              className="mt-1 w-full rounded-md border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-indigo-400"
            />
          </label>
        </div>

        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-slate-100 bg-white px-5 py-3">
          <button type="button" onClick={onClose} className="text-sm text-slate-500 hover:text-slate-700">Cancel</button>
          <button
            type="submit"
            disabled={busy || Math.abs(pctSum - 100) > 0.01}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium text-white',
              busy || Math.abs(pctSum - 100) > 0.01 ? 'bg-slate-300 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700',
            )}
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            {isEdit ? 'Save changes' : 'Create rule'}
          </button>
        </div>
      </form>
    </div>
  );
}
