import { useState, useEffect, useRef } from 'react';
import { Loader2, BarChart2 } from 'lucide-react';
import { getQuickSightEmbedUrl } from '../../api/client';

/**
 * QuickSight embed — Cost Visibility › Cost Analytics
 *
 * The iframe uses a negative-margin breakout to escape the AppShell content
 * container's padding (px-6 py-6 / md:px-8 md:py-7) and fill the full
 * viewport height below the PageHeader (3.25rem = 52px).
 */
export default function CostAnalytics() {
  const [embedUrl,   setEmbedUrl]   = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [setupMsg,   setSetupMsg]   = useState<string>('');
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string>('');
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function loadEmbed() {
    setLoading(true);
    setError('');
    try {
      const resp = await getQuickSightEmbedUrl();
      setConfigured(resp.configured);
      if (!resp.configured) { setSetupMsg(resp.message ?? ''); return; }
      if (resp.error)       { setError(resp.error); return; }
      setEmbedUrl(resp.embedUrl ?? null);
      if (resp.expiresInMs) {
        const refreshIn = Math.max(resp.expiresInMs - 5 * 60 * 1000, 60_000);
        refreshTimer.current = setTimeout(loadEmbed, refreshIn);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadEmbed();
    return () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); };
  }, []);

  // ── Loading ──────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex min-h-[24rem] items-center justify-center">
        <Loader2 size={22} className="animate-spin text-zinc-300" />
      </div>
    );
  }

  // ── Not configured ───────────────────────────────────────────────────────
  if (configured === false) {
    return (
      <div className="max-w-2xl rounded-xl border border-zinc-200/80 bg-white px-8 py-8 shadow-sm">
        <div className="flex gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-amber-200/80 bg-amber-50">
            <BarChart2 size={20} className="text-amber-600" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-zinc-900">Analytics not configured</h2>
            <p className="mt-1 text-sm leading-relaxed text-zinc-500">
              Deploy the QuickSight stack to enable embedded dashboards:
            </p>
            <code className="mt-2 block rounded-lg bg-zinc-100 px-3 py-2 font-mono text-xs text-zinc-700">
              cdk deploy --context installQuickSight=true
            </code>
            {setupMsg && <p className="mt-3 text-xs text-zinc-400">{setupMsg}</p>}
          </div>
        </div>
      </div>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
        {error}
      </div>
    );
  }

  if (!embedUrl) return null;

  // ── Full-bleed iframe ────────────────────────────────────────────────────
  // Breakout: cancel the container's px-6 py-6 / md:px-8 md:py-7 padding so
  // the iframe reaches the true edges of the content column and fills the
  // full remaining viewport height below the 3.25rem PageHeader.
  return (
    <div
      className="-mx-6 -my-6 overflow-hidden md:-mx-8 md:-my-7"
      style={{ height: 'calc(100vh - 3.25rem)' }}
    >
      <iframe
        src={embedUrl}
        className="h-full w-full border-0"
        title="Cost analytics"
        allowFullScreen
      />
    </div>
  );
}
