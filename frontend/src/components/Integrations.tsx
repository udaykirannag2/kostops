/**
 * Integrations page — configure Slack, Jira, PagerDuty, and Email.
 *
 * Layout:
 *   - Grid of integration cards (connected status)
 *   - Click "Configure" → slide-over panel with fields for that integration
 *   - "Test Connection" validates the webhook/token before saving
 */

import { useState, useEffect, useCallback } from 'react';
import {
  listIntegrations,
  getIntegration,
  saveIntegration,
  deleteIntegration,
  testIntegration,
  type Integration,
} from '../api/client';

// ── Icons ─────────────────────────────────────────────────────────────────────

function SlackIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-7 h-7" fill="none">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52z" fill="#E01E5A"/>
      <path d="M6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z" fill="#E01E5A"/>
      <path d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834z" fill="#36C5F0"/>
      <path d="M8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z" fill="#36C5F0"/>
      <path d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834z" fill="#2EB67D"/>
      <path d="M17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z" fill="#2EB67D"/>
      <path d="M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52z" fill="#ECB22E"/>
      <path d="M15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" fill="#ECB22E"/>
    </svg>
  );
}

function GenericIcon({ letter }: { letter: string }) {
  return (
    <div className="w-7 h-7 rounded-lg bg-gray-200 flex items-center justify-center text-sm font-bold text-gray-500">
      {letter}
    </div>
  );
}

function IntegrationIcon({ icon }: { icon: string }) {
  if (icon === 'slack') return <SlackIcon />;
  return <GenericIcon letter={icon[0].toUpperCase()} />;
}

// ── Slide-over panel ──────────────────────────────────────────────────────────

interface SlackConfig {
  channel:       string;
  notifications: { dailyDigest: boolean; anomalyAlert: boolean; newFinding: boolean };
}


function SlackPanel({
  integration,
  apiUrl,
  onSave,
  onClose,
}: {
  integration:  Integration;
  apiUrl:       string;
  onSave:       () => void;
  onClose:      () => void;
}) {
  const saved = (integration.config ?? {}) as Partial<SlackConfig>;
  const [channel,    setChannel]    = useState(saved.channel ?? '#finops-alerts');
  const [dailyDigest, setDailyDigest] = useState(saved.notifications?.dailyDigest ?? true);
  const [anomalyAlert, setAnomalyAlert] = useState(saved.notifications?.anomalyAlert ?? true);
  const [newFinding,  setNewFinding]  = useState(saved.notifications?.newFinding ?? false);
  const [webhookUrl,  setWebhookUrl]  = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [saving,   setSaving]   = useState(false);
  const [testing,  setTesting]  = useState(false);
  const [testMsg,  setTestMsg]  = useState('');
  const [testErr,  setTestErr]  = useState('');
  const [error,    setError]    = useState('');

  async function handleTest() {
    setTesting(true);
    setTestMsg('');
    setTestErr('');
    try {
      const r = await testIntegration('slack');
      setTestMsg(r.message);
    } catch (e) {
      setTestErr(e instanceof Error ? e.message : 'Test failed');
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      await saveIntegration(
        'slack',
        {
          channel,
          notifications: { dailyDigest, anomalyAlert, newFinding },
        },
        { webhookUrl, signingSecret },
      );
      onSave();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">

      {/* Webhook URL */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Incoming Webhook URL
        </label>
        <input
          type="password"
          placeholder={integration.secrets?.webhookUrl || 'https://hooks.slack.com/services/…'}
          value={webhookUrl}
          onChange={e => setWebhookUrl(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <p className="text-xs text-gray-500 mt-1">
          Slack App → Incoming Webhooks → Add New Webhook
        </p>
      </div>

      {/* Signing Secret */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Signing Secret <span className="text-gray-400 font-normal">(for /kostops slash command)</span>
        </label>
        <input
          type="password"
          placeholder={integration.secrets?.signingSecret || 'Slack App → Basic Information'}
          value={signingSecret}
          onChange={e => setSigningSecret(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      {/* Channel */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Default Channel</label>
        <input
          type="text"
          value={channel}
          onChange={e => setChannel(e.target.value)}
          placeholder="#finops-alerts"
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      {/* Notifications */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Notifications</label>
        <div className="space-y-2">
          {[
            { label: 'Daily digest (9am weekdays)', value: dailyDigest, set: setDailyDigest },
            { label: 'Cost anomaly alerts',          value: anomalyAlert, set: setAnomalyAlert },
            { label: 'New finding created',          value: newFinding,  set: setNewFinding },
          ].map(({ label, value, set }) => (
            <label key={label} className="flex items-center gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={value}
                onChange={e => set(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="text-sm text-gray-700">{label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Slash command setup */}
      <div className="bg-gray-50 rounded-md p-3 border border-gray-200">
        <p className="text-xs font-medium text-gray-600 mb-1">Slash Command Setup</p>
        <p className="text-xs text-gray-500 mb-2">
          Paste this URL into your Slack App → Slash Commands → <code>/kostops</code>
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs bg-white border border-gray-200 rounded px-2 py-1.5 text-gray-700 truncate">
            {apiUrl}slack/command
          </code>
          <button
            onClick={() => navigator.clipboard.writeText(`${apiUrl}slack/command`)}
            className="text-xs text-brand-600 hover:text-brand-700 font-medium shrink-0"
          >
            Copy
          </button>
        </div>
      </div>

      {/* Test */}
      {testMsg && <p className="text-sm text-green-600">✅ {testMsg}</p>}
      {testErr && <p className="text-sm text-red-600">❌ {testErr}</p>}
      {error   && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-2 pt-2">
        <button
          onClick={handleTest}
          disabled={testing}
          className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          {testing ? 'Sending…' : 'Test Connection'}
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 px-3 py-2 bg-brand-600 text-white rounded-md text-sm font-medium hover:bg-brand-700 disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function ComingSoonPanel({ name }: { name: string }) {
  return (
    <div className="text-center py-8 text-gray-500">
      <p className="text-4xl mb-3">🚧</p>
      <p className="font-medium text-gray-700 capitalize">{name} integration</p>
      <p className="text-sm mt-1">Coming soon in the next release.</p>
    </div>
  );
}

// ── Slide-over wrapper ────────────────────────────────────────────────────────

function SlideOver({
  integration,
  apiUrl,
  onSave,
  onClose,
}: {
  integration: Integration;
  apiUrl:      string;
  onSave:      () => void;
  onClose:     () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative w-full max-w-md bg-white shadow-xl flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <IntegrationIcon icon={integration.icon} />
            <div>
              <h2 className="text-base font-semibold text-gray-900">
                Configure {integration.displayName}
              </h2>
              <p className="text-xs text-gray-500">{integration.description}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {integration.name === 'slack' ? (
            <SlackPanel
              integration={integration}
              apiUrl={apiUrl}
              onSave={onSave}
              onClose={onClose}
            />
          ) : (
            <ComingSoonPanel name={integration.name} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Integration card ──────────────────────────────────────────────────────────

function IntegrationCard({
  integration,
  onConfigure,
  onDisconnect,
}: {
  integration:  Integration;
  onConfigure:  () => void;
  onDisconnect: () => void;
}) {
  const [disconnecting, setDisconnecting] = useState(false);

  async function handleDisconnect() {
    if (!confirm(`Disconnect ${integration.displayName}?`)) return;
    setDisconnecting(true);
    try {
      await deleteIntegration(integration.name);
      onDisconnect();
    } catch {
      // ignore
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 flex items-start gap-4 hover:shadow-sm transition-shadow">
      {/* Icon + status dot */}
      <div className="relative shrink-0 mt-0.5">
        <IntegrationIcon icon={integration.icon} />
        <span
          className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-white ${
            integration.connected ? 'bg-green-500' : 'bg-gray-300'
          }`}
        />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-gray-900 text-sm">{integration.displayName}</span>
          {integration.connected && (
            <span className="text-xs px-1.5 py-0.5 bg-green-50 text-green-700 rounded-full font-medium">
              Connected
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{integration.description}</p>
        {integration.connected && !!integration.config?.channel && (
          <p className="text-xs text-gray-400 mt-1">
            → {String(integration.config.channel)}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-col items-end gap-1.5 shrink-0">
        <button
          onClick={onConfigure}
          className="text-xs px-3 py-1.5 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 font-medium transition-colors"
        >
          {integration.connected ? 'Edit' : 'Connect'}
        </button>
        {integration.connected && (
          <button
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="text-xs text-red-500 hover:text-red-700 transition-colors disabled:opacity-50"
          >
            {disconnecting ? 'Removing…' : 'Disconnect'}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Integrations() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState('');
  const [selected,     setSelected]     = useState<Integration | null>(null);

  const [apiUrl, setApiUrl] = useState('');
  useEffect(() => {
    import('../runtimeConfig').then(m => m.getRuntimeConfig()).then(c => setApiUrl(c.apiUrl)).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { integrations: list } = await listIntegrations();
      setIntegrations(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load integrations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function openPanel(integration: Integration) {
    // Reload this integration to get masked secret values
    try {
      const full = await getIntegration(integration.name);
      setSelected(full);
    } catch {
      setSelected(integration);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-gray-50">
      <div className="max-w-3xl mx-auto w-full px-6 py-8">

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-xl font-bold text-gray-900">Integrations</h1>
          <p className="text-sm text-gray-500 mt-1">
            Connect KostOps to your team's tools for alerts, tickets, and reports.
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Grid */}
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="bg-white rounded-xl border border-gray-200 p-5 animate-pulse">
                <div className="flex gap-4">
                  <div className="w-7 h-7 bg-gray-200 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-gray-200 rounded w-24" />
                    <div className="h-3 bg-gray-100 rounded w-48" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {integrations.map(intg => (
              <IntegrationCard
                key={intg.name}
                integration={intg}
                onConfigure={() => openPanel(intg)}
                onDisconnect={load}
              />
            ))}
          </div>
        )}
      </div>

      {/* Slide-over */}
      {selected && (
        <SlideOver
          integration={selected}
          apiUrl={apiUrl}
          onSave={load}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
