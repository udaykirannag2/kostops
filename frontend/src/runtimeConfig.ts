/**
 * Cognito + API URL for the KostOps UI.
 *
 * Production: `runtime-config.json` is deployed next to index.html (CDK resolves
 * real IDs at deploy time — do not rely on Vite env for that).
 *
 * Local dev: set VITE_* in frontend/.env (see .env.example).
 */

export interface KostOpsRuntimeConfig {
  userPoolId: string;
  userPoolClientId: string;
  apiUrl: string;
}

let cache: KostOpsRuntimeConfig | null = null;

function fromEnv(): KostOpsRuntimeConfig | null {
  const userPoolId = import.meta.env.VITE_USER_POOL_ID?.trim() ?? '';
  const userPoolClientId = import.meta.env.VITE_USER_POOL_CLIENT_ID?.trim() ?? '';
  const apiUrl = import.meta.env.VITE_API_URL?.trim() ?? '';
  if (!userPoolId || !userPoolClientId || !apiUrl) return null;
  if (userPoolId.includes('${Token')) return null;
  if (!userPoolId.includes('_')) return null;
  return { userPoolId, userPoolClientId, apiUrl };
}

function parseConfigJson(text: string): KostOpsRuntimeConfig | null {
  const t = text.trim();
  if (!t.startsWith('{')) return null;
  let data: unknown;
  try {
    data = JSON.parse(t);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  const userPoolId = typeof o.userPoolId === 'string' ? o.userPoolId.trim() : '';
  const userPoolClientId =
    typeof o.userPoolClientId === 'string' ? o.userPoolClientId.trim() : '';
  const apiUrl = typeof o.apiUrl === 'string' ? o.apiUrl.trim() : '';
  if (!userPoolId.includes('_') || !userPoolClientId || !apiUrl) return null;
  return { userPoolId, userPoolClientId, apiUrl };
}

/**
 * Loads and caches runtime config. Safe to call from many places.
 */
export async function getRuntimeConfig(): Promise<KostOpsRuntimeConfig> {
  if (cache) return cache;

  try {
    const res = await fetch('/runtime-config.json', { cache: 'no-store' });
    if (res.ok) {
      const parsed = parseConfigJson(await res.text());
      if (parsed) {
        cache = parsed;
        return cache;
      }
    }
  } catch {
    /* ignore — use .env below */
  }

  const env = fromEnv();
  if (env) {
    cache = env;
    return cache;
  }

  throw new Error(
    'Missing KostOps configuration. For the hosted app, runtime-config.json should be deployed with the site. ' +
      'For local dev, copy frontend/.env.example to frontend/.env and set VITE_USER_POOL_ID, VITE_USER_POOL_CLIENT_ID, and VITE_API_URL from CloudFormation outputs.',
  );
}
