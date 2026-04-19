import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import {
  listVisibilityFilters, getVisibilityDashboard,
  type DashboardType, type VisibilityFilters, type VisibilityDashboard,
} from '../../api/client';
import { FilterBar, useFilterSelection } from './FilterBar';
import { MonthlyTrendPanel } from './panels/MonthlyTrendPanel';
import { TopTablePanel }     from './panels/TopTablePanel';

/**
 * Native dashboard — replaces the QuickSight EmbedPage.
 *
 * Data flow:
 *   1. Load filter options (/visibility/filters) once per page.
 *   2. Read filter selection from URL params (shareable links).
 *   3. Fetch panels (/visibility/dashboard?type=…&…filters) whenever the URL
 *      selection changes. Panels render via type-specific components:
 *        monthly_trend → <MonthlyTrendPanel />
 *        top_services / top_accounts → <TopTablePanel />
 */
export function NativeDashboard({ type }: { type: DashboardType }) {
  const [filters, setFilters]             = useState<VisibilityFilters | null>(null);
  const [filtersLoading, setFiltersLoad]  = useState(true);
  const [filtersError, setFiltersError]   = useState<string | null>(null);

  const [dashboard, setDashboard]         = useState<VisibilityDashboard | null>(null);
  const [loading, setLoading]             = useState(false);
  const [error, setError]                 = useState<string | null>(null);

  const [selection, setSelection] = useFilterSelection();

  useEffect(() => {
    let cancelled = false;
    setFiltersLoad(true);
    setFiltersError(null);
    listVisibilityFilters()
      .then((data) => { if (!cancelled) setFilters(data); })
      .catch((err) => { if (!cancelled) setFiltersError(err instanceof Error ? err.message : 'Failed to load filters'); })
      .finally(() => { if (!cancelled) setFiltersLoad(false); });
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getVisibilityDashboard(type, {
        linkedAccountIds: selection.linkedAccountIds,
        accountIds:       selection.accountIds,
        ouIds:            selection.ouIds,
        startPeriod:      selection.startPeriod,
        endPeriod:        selection.endPeriod,
      });
      setDashboard(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, [type, selection]);

  useEffect(() => { load(); }, [load]);

  const panelsById = useMemo(() => {
    const m: Record<string, typeof dashboard extends null ? never : NonNullable<typeof dashboard>['panels'][number]> = {};
    for (const p of dashboard?.panels ?? []) m[p.id] = p;
    return m;
  }, [dashboard]);

  return (
    <div className="space-y-4">
      <FilterBar
        filters={filters}
        loading={filtersLoading}
        selection={selection}
        onChange={setSelection}
      />

      {filtersError && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle size={14} /> Filters unavailable: {filtersError}. Dashboards still work without them.
        </div>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900 capitalize">
          {type.replace('-', ' ')}
        </h2>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading && !dashboard && (
        <div className="flex items-center gap-2 p-8 text-slate-500">
          <Loader2 size={16} className="animate-spin" /> Querying CUR…
        </div>
      )}

      {dashboard && (
        <div className="grid grid-cols-1 gap-4">
          {panelsById.monthly_trend && (
            <MonthlyTrendPanel panel={panelsById.monthly_trend} />
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {panelsById.top_services && (
              <TopTablePanel
                panel={panelsById.top_services}
                columns={[
                  { key: 'service', label: 'Service' },
                  { key: 'cost',    label: 'Spend',   align: 'right' },
                ]}
              />
            )}
            {panelsById.top_accounts && (
              <TopTablePanel
                panel={panelsById.top_accounts}
                columns={[
                  { key: 'accountName', label: 'Account',     render: (v, r) => String(v || r.accountId) },
                  { key: 'ouName',      label: 'OU' },
                  { key: 'cost',        label: 'Spend',       align: 'right' },
                ]}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
