/**
 * useRole — resolves the signed-in user's KostOps role from Cognito claims.
 *
 * Cognito emits group membership on the ID token as `cognito:groups`. Amplify
 * surfaces that as `session.tokens.idToken.payload['cognito:groups']`, which
 * can be either a string array or a single string depending on the user pool
 * configuration; we normalise both shapes.
 *
 * Two roles drive RBAC across the whole product:
 *   admin   — full read + write; the UI shows admin-only pages and buttons.
 *   viewer  — read-only; admin items are hidden. Any user not explicitly
 *             placed in the `admin` group is treated as a viewer.
 *
 * All three RBAC layers (UI / API / supervisor) are independent — hiding a
 * button does not protect the API; this hook is only for UX polish.
 */

import { useEffect, useState } from 'react';
import { fetchAuthSession, Hub } from 'aws-amplify/auth';

export type Role = 'admin' | 'viewer';

export interface RoleState {
  role:    Role;
  isAdmin: boolean;
  /** true while the first session fetch is in-flight */
  loading: boolean;
  /** Cognito sub of the current user, or empty string while loading */
  sub:     string;
  email:   string;
  /** Force a re-read (e.g. after a self-promotion that requires token refresh) */
  refresh: () => void;
}

function normaliseGroups(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    return raw
      .replace(/^\[|\]$/g, '')
      .split(/[ ,]+/)
      .map((g) => g.trim())
      .filter(Boolean);
  }
  return [];
}

export function useRole(): RoleState {
  const [state, setState] = useState<Omit<RoleState, 'refresh'>>({
    role:    'viewer',
    isAdmin: false,
    loading: true,
    sub:     '',
    email:   '',
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        // forceRefresh=false — use the cached session; the hub listener below
        // catches token refreshes so we pick up role changes without polling.
        const session = await fetchAuthSession();
        const payload = session.tokens?.idToken?.payload ?? {};
        const groups  = normaliseGroups(payload['cognito:groups']);
        const isAdmin = groups.includes('admin');
        if (cancelled) return;
        setState({
          role:    isAdmin ? 'admin' : 'viewer',
          isAdmin,
          loading: false,
          sub:     String(payload.sub ?? ''),
          email:   String(payload.email ?? ''),
        });
      } catch {
        if (cancelled) return;
        setState((s) => ({ ...s, loading: false }));
      }
    }

    load();
    const unsub = Hub.listen('auth', ({ payload }) => {
      if (payload.event === 'signedIn' || payload.event === 'tokenRefresh') {
        load();
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [tick]);

  return { ...state, refresh: () => setTick((t) => t + 1) };
}
