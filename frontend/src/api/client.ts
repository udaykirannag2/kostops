/**
 * API client — all calls to the KostOps API Gateway backend.
 * Automatically attaches the Cognito JWT from Amplify to every request.
 */

import { fetchAuthSession } from 'aws-amplify/auth';
import { getRuntimeConfig } from '../runtimeConfig';

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
  const [token, { apiUrl }] = await Promise.all([getToken(), getRuntimeConfig()]);

  const response = await fetch(`${apiUrl}${path}`, {
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

// ── Chat Sessions ─────────────────────────────────────────────────────────────

export interface ChatMessage {
  role:      'user' | 'assistant';
  content:   string;
  timestamp: string;  // ISO 8601
}

export interface ChatSessionSummary {
  sessionId:    string;
  title:        string;
  updatedAt:    string;
  messageCount: number;
}

export interface ChatSessionDetail extends ChatSessionSummary {
  messages: ChatMessage[];
}

export interface ChatSessionsResponse {
  sessions: ChatSessionSummary[];
}

export function listChatSessions(): Promise<ChatSessionsResponse> {
  return apiFetch<ChatSessionsResponse>('/chat/sessions');
}

export function getChatSession(sessionId: string): Promise<ChatSessionDetail> {
  return apiFetch<ChatSessionDetail>(`/chat/sessions/${sessionId}`);
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

// ── Integrations ──────────────────────────────────────────────────────────────

export interface Integration {
  name:         string;
  displayName:  string;
  description:  string;
  icon:         string;
  connected:    boolean;
  configuredAt: string | null;
  config:       Record<string, unknown>;
  secrets?:     Record<string, string>;  // masked values only
}

export interface IntegrationsResponse {
  integrations: Integration[];
}

export function listIntegrations(): Promise<IntegrationsResponse> {
  return apiFetch<IntegrationsResponse>('/integrations');
}

export function getIntegration(name: string): Promise<Integration> {
  return apiFetch<Integration>(`/integrations/${name}`);
}

export function saveIntegration(
  name:    string,
  config:  Record<string, unknown>,
  secrets: Record<string, string>,
): Promise<{ name: string; connected: boolean; configuredAt: string }> {
  return apiFetch(`/integrations/${name}`, {
    method: 'PUT',
    body:   JSON.stringify({ config, secrets }),
  });
}

export function deleteIntegration(name: string): Promise<{ connected: boolean }> {
  return apiFetch(`/integrations/${name}`, { method: 'DELETE' });
}

export function testIntegration(name: string): Promise<{ ok: boolean; message: string }> {
  return apiFetch(`/integrations/${name}/test`, { method: 'POST' });
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export interface MonthlySpend {
  year_month: string;  // e.g. "2026-03"
  total_cost: number;
  currency:   string;
}

export interface MonthlySpendResponse {
  monthly_spend: MonthlySpend[];
}

export function getMonthlySpend(): Promise<MonthlySpendResponse> {
  return apiFetch<MonthlySpendResponse>('/dashboard/monthly-spend');
}

// ── Visibility (native dashboards) ────────────────────────────────────────────

export type DashboardType =
  | 'billing-summary'
  | 'compute'
  | 'storage'
  | 'ai-ml'
  | 'commitments'
  | 'rightsizing';

export interface AccountOption {
  id:      string;
  name:    string;
  email?:  string;
  ouId?:   string;
  ouName?: string;
}
export interface OuOption   { id: string; name: string; parentId?: string }

export interface VisibilityFilters {
  accounts: AccountOption[];
  ous:      OuOption[];
  periods:  string[];   // YYYY-MM
}

export interface DashboardPanel {
  id:    string;
  title: string;
  kind:  'bar' | 'line' | 'table' | 'error';
  data:  Array<Record<string, unknown>>;
  error?: string;
}
export interface VisibilityDashboard {
  type:   DashboardType;
  panels: DashboardPanel[];
}

export interface VisibilityFilterSelection {
  linkedAccountIds?: string[];
  accountIds?:       string[];   // resolved from account-name dropdown
  ouIds?:            string[];
  startPeriod?:      string;     // YYYY-MM
  endPeriod?:        string;     // YYYY-MM
}

function _qs(params: VisibilityFilterSelection): string {
  const parts: string[] = [];
  const push = (k: string, v?: string[] | string) => {
    if (!v) return;
    const s = Array.isArray(v) ? v.join(',') : v;
    if (s) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(s)}`);
  };
  push('linkedAccountIds', params.linkedAccountIds);
  push('accountIds',       params.accountIds);
  push('ouIds',            params.ouIds);
  push('startPeriod',      params.startPeriod);
  push('endPeriod',        params.endPeriod);
  return parts.length ? `&${parts.join('&')}` : '';
}

export function listVisibilityFilters(): Promise<VisibilityFilters> {
  return apiFetch<VisibilityFilters>('/visibility/filters');
}

export function getVisibilityDashboard(
  type:    DashboardType,
  filters: VisibilityFilterSelection = {},
): Promise<VisibilityDashboard> {
  return apiFetch<VisibilityDashboard>(
    `/visibility/dashboard?type=${encodeURIComponent(type)}${_qs(filters)}`,
  );
}

// ── Members (admin-only) ──────────────────────────────────────────────────────

export type MemberRole = 'admin' | 'viewer';

export interface Member {
  sub:       string;
  username:  string;
  email:     string;
  status:    string;    // Cognito UserStatus (e.g. CONFIRMED, FORCE_CHANGE_PASSWORD)
  enabled:   boolean;
  createdAt: string;
  role:      MemberRole;
}

export interface MembersResponse {
  members: Member[];
  count:   number;
}

export function listMembers(): Promise<MembersResponse> {
  return apiFetch<MembersResponse>('/members');
}

export function inviteMember(email: string, role: MemberRole): Promise<Member> {
  return apiFetch<Member>('/members', {
    method: 'POST',
    body:   JSON.stringify({ email, role }),
  });
}

export function changeMemberRole(
  sub:  string,
  role: MemberRole,
): Promise<{ username: string; role: MemberRole }> {
  return apiFetch(`/members/${encodeURIComponent(sub)}`, {
    method: 'PUT',
    body:   JSON.stringify({ role }),
  });
}

export function disableMember(sub: string): Promise<{ username: string; enabled: boolean }> {
  return apiFetch(`/members/${encodeURIComponent(sub)}`, { method: 'DELETE' });
}

// ── QuickSight embed ──────────────────────────────────────────────────────────

export type DashboardKey =
  | 'overview'
  | 'billing-summary'
  | 'compute'
  | 'storage'
  | 'ai-ml'
  | 'commitments'
  | 'rightsizing';

export interface QuickSightEmbedResponse {
  configured:   boolean;
  embedUrl?:    string;
  expiresInMs?: number;
  message?:     string;
  error?:       string;
}

export function getQuickSightEmbedUrl(
  dashboard: DashboardKey = 'overview',
): Promise<QuickSightEmbedResponse> {
  return apiFetch<QuickSightEmbedResponse>(
    `/dashboard/quicksight-url?dashboard=${dashboard}`,
  );
}
