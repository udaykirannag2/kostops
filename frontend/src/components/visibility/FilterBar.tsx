import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Filter, Loader2 } from 'lucide-react';
import { MultiSelect } from './MultiSelect';
import type { VisibilityFilters } from '../../api/client';

export interface FilterSelection {
  linkedAccountIds: string[];
  accountIds:       string[];  // by account name (resolves to IDs)
  ouIds:            string[];
  startPeriod?:     string;
  endPeriod?:       string;
}

interface FilterBarProps {
  filters:    VisibilityFilters | null;
  loading:    boolean;
  selection:  FilterSelection;
  onChange:   (next: FilterSelection) => void;
}

/**
 * Persists state in URL search params so dashboards stay shareable and the
 * supervisor / chat can deep-link to a specific filtered view.
 */
export function useFilterSelection(): [FilterSelection, (next: FilterSelection) => void] {
  const [sp, setSp] = useSearchParams();
  const selection: FilterSelection = useMemo(() => ({
    linkedAccountIds: (sp.get('linkedAccountIds') ?? '').split(',').filter(Boolean),
    accountIds:       (sp.get('accountIds')       ?? '').split(',').filter(Boolean),
    ouIds:            (sp.get('ouIds')            ?? '').split(',').filter(Boolean),
    startPeriod:      sp.get('startPeriod') ?? undefined,
    endPeriod:        sp.get('endPeriod')   ?? undefined,
  }), [sp]);

  function setSelection(next: FilterSelection) {
    const params = new URLSearchParams(sp);
    const writeList = (k: string, v: string[]) => {
      if (v.length) params.set(k, v.join(','));
      else          params.delete(k);
    };
    const writeScalar = (k: string, v?: string) => {
      if (v) params.set(k, v);
      else   params.delete(k);
    };
    writeList('linkedAccountIds', next.linkedAccountIds);
    writeList('accountIds',       next.accountIds);
    writeList('ouIds',            next.ouIds);
    writeScalar('startPeriod',    next.startPeriod);
    writeScalar('endPeriod',      next.endPeriod);
    setSp(params, { replace: true });
  }

  return [selection, setSelection];
}

export function FilterBar({ filters, loading, selection, onChange }: FilterBarProps) {
  const linkedAccountOptions = useMemo(
    () => (filters?.accounts ?? []).map((a) => ({
      value: a.id,
      label: a.id,
      hint:  a.name || '',
    })),
    [filters],
  );

  const accountNameOptions = useMemo(() => {
    const byName = new Map<string, string[]>();
    for (const a of filters?.accounts ?? []) {
      const key = a.name || a.id;
      const arr = byName.get(key) ?? [];
      arr.push(a.id);
      byName.set(key, arr);
    }
    return Array.from(byName.entries())
      .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map(([name, ids]) => ({ value: ids.join('|'), label: name, hint: ids.length > 1 ? `${ids.length} ids` : ids[0] }));
  }, [filters]);

  const ouOptions = useMemo(
    () => (filters?.ous ?? []).map((o) => ({ value: o.id, label: o.name })),
    [filters],
  );

  const periodOptions = useMemo(
    () => (filters?.periods ?? []).map((p) => ({ value: p, label: p })),
    [filters],
  );

  function setAccountNameSelection(selected: string[]) {
    // value is '|' joined list of ids so one name → many ids
    const ids = new Set<string>();
    for (const v of selected) v.split('|').forEach((id) => id && ids.add(id));
    onChange({ ...selection, accountIds: Array.from(ids) });
  }

  // Current "accountName" selection = group of IDs that share a name, matched
  // back into name-level tokens so the dropdown visual stays consistent.
  const currentAccountNameSelection = useMemo(() => {
    const selIds = new Set(selection.accountIds);
    return accountNameOptions
      .filter((opt) => opt.value.split('|').some((id) => selIds.has(id)))
      .map((opt) => opt.value);
  }, [accountNameOptions, selection.accountIds]);

  function onStartPeriod(vals: string[]) {
    onChange({ ...selection, startPeriod: vals[0] });
  }
  function onEndPeriod(vals: string[]) {
    onChange({ ...selection, endPeriod: vals[0] });
  }

  const anySelected =
    selection.linkedAccountIds.length > 0 ||
    selection.accountIds.length       > 0 ||
    selection.ouIds.length            > 0 ||
    !!selection.startPeriod || !!selection.endPeriod;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex items-center gap-2 mb-3 text-sm font-medium text-slate-700">
        <Filter size={14} /> Filters
        {loading && <Loader2 size={13} className="animate-spin text-slate-400" />}
        {anySelected && (
          <button
            type="button"
            onClick={() => onChange({ linkedAccountIds: [], accountIds: [], ouIds: [] })}
            className="ml-auto text-xs font-normal text-indigo-600 hover:text-indigo-800"
          >
            Reset all
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <MultiSelect
          label="Linked account"
          options={linkedAccountOptions}
          selected={selection.linkedAccountIds}
          onChange={(ids) => onChange({ ...selection, linkedAccountIds: ids })}
          placeholder="All accounts"
        />
        <MultiSelect
          label="Account name"
          options={accountNameOptions}
          selected={currentAccountNameSelection}
          onChange={setAccountNameSelection}
          placeholder="All names"
        />
        <MultiSelect
          label="OU name"
          options={ouOptions}
          selected={selection.ouIds}
          onChange={(ids) => onChange({ ...selection, ouIds: ids })}
          placeholder="All OUs"
        />
        <div className="grid grid-cols-2 gap-2">
          <MultiSelect
            label="From"
            options={periodOptions}
            selected={selection.startPeriod ? [selection.startPeriod] : []}
            onChange={onStartPeriod}
            placeholder="Earliest"
          />
          <MultiSelect
            label="To"
            options={periodOptions}
            selected={selection.endPeriod ? [selection.endPeriod] : []}
            onChange={onEndPeriod}
            placeholder="Latest"
          />
        </div>
      </div>
    </div>
  );
}
