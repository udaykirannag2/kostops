import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus, RefreshCw, Loader2, Archive, Users, Layers, Building2, Pencil, X,
} from 'lucide-react';
import clsx from 'clsx';
import {
  listScopes, createScope, archiveScope, updateScope,
  listVisibilityFilters,
  type Scope, type ScopeType, type ScopeInput, type VisibilityFilters,
} from '../../api/client';
import { useRole } from '../../auth/useRole';
import { MultiSelect } from '../../components/visibility/MultiSelect';

const SCOPE_TYPES: { value: ScopeType; label: string; hint: string; icon: React.ReactNode }[] = [
  { value: 'TEAM',    label: 'Team',        hint: 'OU + account overrides',          icon: <Users      size={13} /> },
  { value: 'OU',      label: 'OU',          hint: 'One or more Organizations OUs',   icon: <Building2  size={13} /> },
  { value: 'ACCOUNT', label: 'Account bag', hint: 'Explicit account ID list',        icon: <Layers     size={13} /> },
  { value: 'CUSTOM',  label: 'Custom',      hint: 'Arbitrary include/exclude bag',   icon: <Layers     size={13} /> },
];

const EMPTY_INPUT: ScopeInput = {
  name:              '',
  scopeType:         'TEAM',
  ouIds:             [],
  includeAccountIds: [],
  excludeAccountIds: [],
};

export default function ScopesPage() {
  const { isAdmin, loading: roleLoading } = useRole();
  const [scopes,   setScopes]   = useState<Scope[]>([]);
  const [filters,  setFilters]  = useState<VisibilityFilters | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);
  const [busy,     setBusy]     = useState<string | null>(null);

  const [editOpen,    setEditOpen]    = useState(false);
  const [editTarget,  setEditTarget]  = useState<Scope | null>(null);
  const [editInput,   setEditInput]   = useState<ScopeInput>(EMPTY_INPUT);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listScopes('active');
      setScopes(data.scopes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load scopes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { listVisibilityFilters().then(setFilters).catch(() => setFilters(null)); }, []);

  function openCreate() {
    setEditTarget(null);
    setEditInput({ ...EMPTY_INPUT });
    setEditOpen(true);
  }
  function openEdit(scope: Scope) {
    setEditTarget(scope);
    setEditInput({
      name:               scope.name,
      scopeType:          scope.scopeType,
      ouIds:              scope.ouIds || [],
      includeAccountIds:  scope.includeAccountIds || [],
      excludeAccountIds:  scope.excludeAccountIds || [],
      parentScopeId:      scope.parentScopeId ?? undefined,
    });
    setEditOpen(true);
  }
  function closeEdit() {
    setEditOpen(false);
    setEditTarget(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!editInput.name.trim()) { setError('Name is required'); return; }
    setBusy('save');
    try {
      if (editTarget) {
        await updateScope(editTarget.scopeId, editInput);
      } else {
        await createScope(editInput);
      }
      closeEdit();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(null);
    }
  }

  async function handleArchive(scope: Scope) {
    if (!confirm(`Archive scope "${scope.name}"? Budgets for this scope stay in history.`)) return;
    setBusy(scope.scopeId);
    try {
      await archiveScope(scope.scopeId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Archive failed');
    } finally {
      setBusy(null);
    }
  }

  const accountOptions = useMemo(
    () => (filters?.accounts ?? []).map((a) => ({ value: a.id, label: a.id, hint: a.name || '' })),
    [filters],
  );
  const ouOptions = useMemo(
    () => (filters?.ous ?? []).map((o) => ({ value: o.id, label: o.name, hint: o.id })),
    [filters],
  );

  if (roleLoading) return <InlineLoading text="Checking permissions…" />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-500">
          {scopes.length} active {scopes.length === 1 ? 'scope' : 'scopes'}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            <RefreshCw size={14} /> Refresh
          </button>
          {isAdmin && (
            <button
              onClick={openCreate}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
            >
              <Plus size={14} /> New scope
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">OUs</th>
              <th className="px-4 py-2 font-medium">Accounts (inc/exc)</th>
              <th className="px-4 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                <Loader2 size={16} className="inline animate-spin" /> Loading…
              </td></tr>
            )}
            {!loading && scopes.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                No scopes yet. {isAdmin ? 'Click "New scope" to create one.' : 'Ask an admin to create one.'}
              </td></tr>
            )}
            {!loading && scopes.map((s) => {
              const typeMeta = SCOPE_TYPES.find((t) => t.value === s.scopeType);
              return (
                <tr key={s.scopeId}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{s.name}</div>
                    <div className="text-xs text-slate-400">{s.scopeId}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-2 py-0.5 text-xs font-medium ring-1 ring-slate-200 text-slate-700">
                      {typeMeta?.icon} {typeMeta?.label ?? s.scopeType}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    {(s.ouIds ?? []).length === 0 ? '—' : `${(s.ouIds ?? []).length} OU(s)`}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    {((s.includeAccountIds ?? []).length || (s.excludeAccountIds ?? []).length)
                      ? <>+{(s.includeAccountIds ?? []).length} / −{(s.excludeAccountIds ?? []).length}</>
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {isAdmin && (
                      <div className="inline-flex items-center gap-2">
                        <button
                          onClick={() => openEdit(s)}
                          disabled={busy === s.scopeId}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                          <Pencil size={12} /> Edit
                        </button>
                        <button
                          onClick={() => handleArchive(s)}
                          disabled={busy === s.scopeId}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                        >
                          <Archive size={12} /> Archive
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editOpen && (
        <ScopeEditor
          input={editInput}
          setInput={setEditInput}
          onSave={handleSave}
          onClose={closeEdit}
          busy={busy === 'save'}
          accountOptions={accountOptions}
          ouOptions={ouOptions}
          isEdit={!!editTarget}
        />
      )}

      <p className="text-xs text-slate-500">
        Scopes define which AWS accounts each team owns. Budgets attach to a scope and roll up through included accounts.
        {' '}<span className="text-slate-400">Admin actions: new / edit / archive.</span>
      </p>
    </div>
  );
}

function InlineLoading({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-slate-500 text-sm">
      <Loader2 size={14} className="animate-spin" /> {text}
    </div>
  );
}

function ScopeEditor({
  input, setInput, onSave, onClose, busy, accountOptions, ouOptions, isEdit,
}: {
  input:          ScopeInput;
  setInput:       (input: ScopeInput) => void;
  onSave:         (e: React.FormEvent) => void;
  onClose:        () => void;
  busy:           boolean;
  accountOptions: { value: string; label: string; hint?: string }[];
  ouOptions:      { value: string; label: string; hint?: string }[];
  isEdit:         boolean;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4">
      <form
        onSubmit={onSave}
        className="w-full max-w-2xl rounded-lg bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-900">
            {isEdit ? 'Edit scope' : 'New scope'}
          </h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Name</span>
            <input
              required
              value={input.name}
              onChange={(e) => setInput({ ...input, name: e.target.value })}
              placeholder="Platform Engineering"
              className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Scope type</span>
            <select
              value={input.scopeType}
              onChange={(e) => setInput({ ...input, scopeType: e.target.value as ScopeType })}
              className="mt-1 block w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400"
            >
              {SCOPE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label} — {t.hint}</option>
              ))}
            </select>
          </label>

          <div className={clsx(input.scopeType === 'ACCOUNT' && 'opacity-50 pointer-events-none')}>
            <MultiSelect
              label="OU ids (OU / TEAM scopes)"
              options={ouOptions}
              selected={input.ouIds ?? []}
              onChange={(ids) => setInput({ ...input, ouIds: ids })}
              placeholder="No OUs selected"
            />
          </div>

          <MultiSelect
            label="Include account ids (overrides)"
            options={accountOptions}
            selected={input.includeAccountIds ?? []}
            onChange={(ids) => setInput({ ...input, includeAccountIds: ids })}
            placeholder="No overrides"
          />

          <MultiSelect
            label="Exclude account ids"
            options={accountOptions}
            selected={input.excludeAccountIds ?? []}
            onChange={(ids) => setInput({ ...input, excludeAccountIds: ids })}
            placeholder="No exclusions"
          />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button type="button" onClick={onClose} className="text-sm text-slate-500 hover:text-slate-700">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            {isEdit ? 'Save changes' : 'Create scope'}
          </button>
        </div>
      </form>
    </div>
  );
}
