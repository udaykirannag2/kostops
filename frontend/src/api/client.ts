/**
 * API client — all calls to the KostOps API Gateway backend.
 * Automatically attaches the Cognito JWT from Amplify to every request.
 */

import { fetchAuthSession } from 'aws-amplify/auth';

const API_URL = import.meta.env.VITE_API_URL as string;

async function getToken(): Promise<string> {
  const session = await fetchAuthSession();
  const token   = session.tokens?.idToken?.toString();
  if (!token) throw new Error('Not authenticated');
  return token;
}

async function apiFetch<T>(
  path:    string,
  options: RequestInit = {},
): Promise<T> {
  const token = await getToken();

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API error ${response.status}: ${body}`);
  }

  return response.json() as Promise<T>;
}

// ── Chat ──────────────────────────────────────────────────────────────────────

export interface ChatResponse {
  reply:     string;
  sessionId: string;
}

export function sendMessage(
  message:   string,
  sessionId: string | null,
): Promise<ChatResponse> {
  return apiFetch<ChatResponse>('/chat', {
    method: 'POST',
    body:   JSON.stringify({ message, sessionId }),
  });
}

// ── Findings ──────────────────────────────────────────────────────────────────

export type FindingStatus = 'OPEN' | 'RESOLVED' | 'IGNORED';
export type FindingType   =
  | 'IDLE_EC2'
  | 'UNATTACHED_EBS'
  | 'OLD_SNAPSHOT'
  | 'RIGHTSIZING'
  | 'SAVINGS_PLAN'
  | 'OTHER';

export interface Finding {
  findingId:                string;
  createdAt:                string;
  status:                   FindingStatus;
  type:                     FindingType;
  title:                    string;
  description:              string;
  estimatedMonthlySavings:  string;  // DynamoDB stores as string
  resourceId?:              string;
  resourceType?:            string;
}

export interface FindingsResponse {
  findings: Finding[];
  count:    number;
}

export function listFindings(status: FindingStatus = 'OPEN'): Promise<FindingsResponse> {
  return apiFetch<FindingsResponse>(`/findings?status=${status}`);
}

export function updateFinding(
  findingId:  string,
  createdAt:  string,
  status:     FindingStatus,
): Promise<Finding> {
  return apiFetch<Finding>(`/findings/${findingId}`, {
    method: 'PATCH',
    body:   JSON.stringify({ createdAt, status }),
  });
}

export function triggerSlackDigest(): Promise<{ sent: boolean; findings: number }> {
  return apiFetch('/slack/digest', { method: 'POST' });
}
