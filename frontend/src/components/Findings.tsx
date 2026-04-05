import { useState, useEffect, useCallback } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  AlertTriangle, CheckCircle, XCircle, RefreshCw,
  TrendingDown, Server, HardDrive, Camera, Layers,
  DollarSign, Bell, ChevronDown, Loader2,
} from 'lucide-react';
import clsx from 'clsx';
import {
  listFindings, updateFinding, triggerSlackDigest,
  type Finding, type FindingStatus, type FindingType,
} from '../api/client';

const TYPE_CONFIG: Record<FindingType, { label: string; icon: React.ReactNode; color: string }> = {
  IDLE_EC2:       { label: 'Idle EC2',       icon: <Server    size={14} />, color: 'text-orange-500 bg-orange-50' },
  UNATTACHED_EBS: { label: 'Unattached EBS', icon: <HardDrive size={14} />, color: 'text-yellow-600 bg-yellow-50' },
  OLD_SNAPSHOT:   { label: 'Old Snapshot',   icon: <Camera    size={14} />, color: 'text-blue-500   bg-blue-50' },
  RIGHTSIZING:    { label: 'Rightsizing',    icon: <Layers    size={14} />, color: 'text-purple-500 bg-purple-50' },
  SAVINGS_PLAN:   { label: 'Savings Plan',   icon: <TrendingDown size={14} />, color: 'text-green-600 bg-green-50' },
  OTHER:          { label: 'Other',          icon: <AlertTriangle size={14} />, color: 'text-gray-500 bg-gray-100' },
};

const STATUS_TABS: { value: FindingStatus; label: string }[] = [
  { value: 'OPEN',     label: 'Open' },
  { value: 'RESOLVED', label: 'Resolved' },
  { value: 'IGNORED',  label: 'Ignored' },
];

function savingsColor(amount: number): string {
  if (amount >= 200) return 'text-red-600';
  if (amount >= 50)  return 'text-yellow-600';
  return 'text-green-600';
}

export default function Findings() {
  const [status,        setStatus]        = useState<FindingStatus>('OPEN');
  const [findings,      setFindings]      = useState<Finding[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState<string | null>(null);
  const [slackSending,  setSlackSending]  = useState(false);
  const [slackSuccess,  setSlackSuccess]  = useState(false);
  const [updatingId,    setUpdatingId]    = useState<string | null>(null);

  const totalSavings = findings.reduce(
    (sum, f) => sum + parseFloat(f.estimatedMonthlySavings || '0'), 0,
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listFindings(status);
      setFindings(data.findings);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load findings');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  async function handleUpdateStatus(finding: Finding, newStatus: FindingStatus) {
    setUpdatingId(finding.findingId);
    try {
      await updateFinding(finding.findingId, finding.createdAt, newStatus);
      setFindings(prev => prev.filter(f => f.findingId !== finding.findingId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update finding');
    } finally {
      setUpdatingId(null);
    }
  }

  async function handleSlackDigest() {
    setSlackSending(true);
    try {
      await triggerSlackDigest();
      setSlackSuccess(true);
      setTimeout(() => setSlackSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send Slack digest');
    } finally {
      setSlackSending(false);
    }
  }

  return (
    <div className="flex flex-col h-full bg-gray-50">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="flex-shrink-0 px-6 py-4 bg-white border-b border-gray-100">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <AlertTriangle size={18} className="text-amber-500" />
              <h1 className="text-base font-semibold text-gray-900">Findings</h1>
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              Savings opportunities identified by the KostOps agent
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={load}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-600
                         border border-gray-200 rounded-lg hover:bg-gray-50
                         disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={13} className={clsx(loading && 'animate-spin')} />
              Refresh
            </button>
            <button
              onClick={handleSlackDigest}
              disabled={slackSending || slackSuccess}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors',
                slackSuccess
                  ? 'bg-green-100 text-green-700 border border-green-200'
                  : 'bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50',
              )}
            >
              {slackSending
                ? <Loader2 size={13} className="animate-spin" />
                : <Bell size={13} />
              }
              {slackSuccess ? 'Sent!' : 'Send Digest'}
            </button>
          </div>
        </div>
      </header>

      {/* ── Summary bar ────────────────────────────────────────────────────── */}
      {status === 'OPEN' && findings.length > 0 && (
        <div className="flex-shrink-0 px-6 py-3 bg-amber-50 border-b border-amber-100">
          <div className="flex items-center gap-2 text-sm">
            <DollarSign size={15} className="text-amber-600" />
            <span className="font-semibold text-amber-800">
              ${totalSavings.toLocaleString(undefined, { maximumFractionDigits: 0 })}/month
            </span>
            <span className="text-amber-600">
              estimated savings across {findings.length} open finding{findings.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>
      )}

      {/* ── Status tabs ────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-6 pt-4 pb-0 bg-white border-b border-gray-100">
        <div className="flex gap-1">
          {STATUS_TABS.map(tab => (
            <button
              key={tab.value}
              onClick={() => setStatus(tab.value)}
              className={clsx(
                'px-4 py-2 text-sm font-medium rounded-t-lg transition-colors',
                status === tab.value
                  ? 'text-brand-600 border-b-2 border-brand-600'
                  : 'text-gray-500 hover:text-gray-700',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Content ────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-6 py-4">

        {error && (
          <div className="mb-4 rounded-xl bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-600">
            {error}
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center h-48">
            <Loader2 size={24} className="animate-spin text-gray-400" />
          </div>
        )}

        {!loading && findings.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 text-center">
            <CheckCircle size={32} className="text-green-400 mb-3" />
            <p className="text-gray-500 font-medium">
              No {status.toLowerCase()} findings
            </p>
            <p className="text-gray-400 text-sm mt-1">
              {status === 'OPEN'
                ? 'Ask the agent to scan for savings opportunities'
                : 'Nothing here yet'}
            </p>
          </div>
        )}

        {!loading && findings.length > 0 && (
          <div className="space-y-3">
            {findings.map(finding => (
              <FindingCard
                key={finding.findingId}
                finding={finding}
                currentStatus={status}
                updating={updatingId === finding.findingId}
                onUpdateStatus={handleUpdateStatus}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FindingCard({
  finding, currentStatus, updating, onUpdateStatus,
}: {
  finding:        Finding;
  currentStatus:  FindingStatus;
  updating:       boolean;
  onUpdateStatus: (f: Finding, s: FindingStatus) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const typeConfig = TYPE_CONFIG[finding.type] ?? TYPE_CONFIG.OTHER;
  const savings    = parseFloat(finding.estimatedMonthlySavings || '0');
  const age        = formatDistanceToNow(new Date(finding.createdAt), { addSuffix: true });

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden hover:border-gray-300 transition-colors">
      <div className="px-5 py-4">
        <div className="flex items-start gap-4">

          {/* Type badge */}
          <span className={clsx(
            'flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium mt-0.5',
            typeConfig.color,
          )}>
            {typeConfig.icon}
            {typeConfig.label}
          </span>

          {/* Title + meta */}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-900 leading-snug">{finding.title}</p>
            <div className="flex items-center gap-3 mt-1">
              <span className={clsx('text-sm font-bold', savingsColor(savings))}>
                ${savings.toLocaleString(undefined, { maximumFractionDigits: 0 })}/mo
              </span>
              {finding.resourceId && (
                <span className="text-xs font-mono text-gray-400">{finding.resourceId}</span>
              )}
              <span className="text-xs text-gray-400">{age}</span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {currentStatus === 'OPEN' && (
              <>
                <ActionButton
                  onClick={() => onUpdateStatus(finding, 'RESOLVED')}
                  loading={updating}
                  icon={<CheckCircle size={14} />}
                  label="Resolve"
                  className="text-green-600 border-green-200 hover:bg-green-50"
                />
                <ActionButton
                  onClick={() => onUpdateStatus(finding, 'IGNORED')}
                  loading={updating}
                  icon={<XCircle size={14} />}
                  label="Ignore"
                  className="text-gray-500 border-gray-200 hover:bg-gray-50"
                />
              </>
            )}
            {currentStatus !== 'OPEN' && (
              <ActionButton
                onClick={() => onUpdateStatus(finding, 'OPEN')}
                loading={updating}
                icon={<RefreshCw size={14} />}
                label="Reopen"
                className="text-brand-600 border-brand-200 hover:bg-brand-50"
              />
            )}
            <button
              onClick={() => setExpanded(v => !v)}
              className="p-1.5 text-gray-400 hover:text-gray-600 transition-colors"
            >
              <ChevronDown
                size={15}
                className={clsx('transition-transform', expanded && 'rotate-180')}
              />
            </button>
          </div>
        </div>

        {/* Expanded description */}
        {expanded && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <p className="text-sm text-gray-600 leading-relaxed">{finding.description}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ActionButton({
  onClick, loading, icon, label, className,
}: {
  onClick:   () => void;
  loading:   boolean;
  icon:      React.ReactNode;
  label:     string;
  className: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={clsx(
        'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium',
        'border rounded-lg transition-colors disabled:opacity-50',
        className,
      )}
    >
      {loading ? <Loader2 size={13} className="animate-spin" /> : icon}
      {label}
    </button>
  );
}
