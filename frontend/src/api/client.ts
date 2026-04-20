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

// ── Scopes & Budgets (Budget Agent) ───────────────────────────────────────────

export type ScopeType = 'ACCOUNT' | 'OU' | 'TEAM' | 'CUSTOM';
export type ScopeStatus = 'active' | 'archived';

export interface Scope {
  scopeId:             string;
  name:                string;
  scopeType:           ScopeType;
  ouIds:               string[];
  includeAccountIds:   string[];
  excludeAccountIds:   string[];
  parentScopeId?:      string | null;
  ownerSub?:           string;
  status:              ScopeStatus;
  createdAt?:          string;
  updatedAt?:          string;
  effectiveAccountIds?: string[];
}

export interface ScopesResponse { scopes: Scope[]; count: number }

export function listScopes(status: ScopeStatus = 'active'): Promise<ScopesResponse> {
  return apiFetch<ScopesResponse>(`/scopes?status=${status}`);
}

export function getScope(scopeId: string, includeEffective = false): Promise<Scope> {
  const q = includeEffective ? '?include=effective' : '';
  return apiFetch<Scope>(`/scopes/${encodeURIComponent(scopeId)}${q}`);
}

export interface EffectiveAccounts { scopeId: string; accountIds: string[]; count: number }
export function getScopeEffectiveAccounts(scopeId: string): Promise<EffectiveAccounts> {
  return apiFetch<EffectiveAccounts>(`/scopes/${encodeURIComponent(scopeId)}/effective-accounts`);
}

export interface ScopeInput {
  name:               string;
  scopeType:          ScopeType;
  ouIds?:             string[];
  includeAccountIds?: string[];
  excludeAccountIds?: string[];
  parentScopeId?:     string;
}

export function createScope(input: ScopeInput): Promise<Scope> {
  return apiFetch<Scope>('/scopes', {
    method: 'POST',
    body:   JSON.stringify(input),
  });
}

export function updateScope(scopeId: string, patch: Partial<ScopeInput>): Promise<Scope> {
  return apiFetch<Scope>(`/scopes/${encodeURIComponent(scopeId)}`, {
    method: 'PUT',
    body:   JSON.stringify(patch),
  });
}

export function archiveScope(scopeId: string): Promise<{ scopeId: string; status: string }> {
  return apiFetch(`/scopes/${encodeURIComponent(scopeId)}`, { method: 'DELETE' });
}

// ── Budgets ────────────────────────────────────────────────────────────

export type BudgetGranularity = 'MONTHLY' | 'QUARTERLY';

export interface BudgetVersion {
  scopeId:     string;
  period:      string;
  version:     number;
  amountUsd:   number;
  granularity: BudgetGranularity;
  currency:    string;
  createdBy:   string;
  createdAt:   string;
  note?:       string;
  isCurrent:   boolean;
}

export function getCurrentBudget(scopeId: string, period: string): Promise<BudgetVersion | null> {
  return apiFetch<BudgetVersion>(`/budgets?scopeId=${encodeURIComponent(scopeId)}&period=${encodeURIComponent(period)}`)
    .catch((err) => {
      if (err instanceof Error && err.message.includes('404')) return null;
      throw err;
    });
}

export interface BudgetHistoryResponse {
  scopeId:  string;
  versions: BudgetVersion[];
}
export function getBudgetHistory(scopeId: string): Promise<BudgetHistoryResponse> {
  return apiFetch<BudgetHistoryResponse>(`/budgets/${encodeURIComponent(scopeId)}/history`);
}

export interface SetBudgetInput {
  amountUsd:    number;
  granularity?: BudgetGranularity;
  note?:        string;
}
export function setBudget(scopeId: string, period: string, input: SetBudgetInput): Promise<BudgetVersion> {
  return apiFetch<BudgetVersion>(
    `/budgets/${encodeURIComponent(scopeId)}/${encodeURIComponent(period)}`,
    { method: 'PUT', body: JSON.stringify(input) },
  );
}

// ── Allocation rules (Phase 3) ────────────────────────────────────────

export type AllocationRuleType =
  | 'PERCENTAGE' | 'DIRECT' | 'FIXED_SPLIT' | 'USAGE_BASED' | 'MANUAL';
export type AllocationStatus = 'active' | 'archived';

export interface AllocationSplit {
  targetScopeId: string;
  pct:           number;
}

export interface AllocationRule {
  ruleId:            string;
  sourceAccountId:   string;
  ruleType:          AllocationRuleType;
  splits:            AllocationSplit[];
  status:            AllocationStatus;
  effectiveFrom?:    string;
  effectiveTo?:      string | null;
  note?:             string;
  createdBy?:        string;
  createdAt?:        string;
  updatedBy?:        string;
  updatedAt?:        string;
}

export interface AllocationRulesResponse { rules: AllocationRule[]; count: number }

export interface AllocationRuleInput {
  sourceAccountId: string;
  ruleType?:       AllocationRuleType;
  splits:          AllocationSplit[];
  effectiveFrom?:  string;
  effectiveTo?:    string;
  note?:           string;
}

export interface AllocationPreviewRow {
  targetScopeId:   string;
  targetScopeName: string;
  pct:             number;
  projectedUsd:    number;
}

export interface AllocationPreviewResponse {
  ruleId:          string;
  sourceAccountId: string;
  period:          string;
  sourceTotalUsd:  number;
  ruleType:        AllocationRuleType;
  projected:       AllocationPreviewRow[];
}

export function listAllocations(sourceAccountId?: string, status: AllocationStatus = 'active'): Promise<AllocationRulesResponse> {
  const qs = new URLSearchParams({ status });
  if (sourceAccountId) qs.set('sourceAccountId', sourceAccountId);
  return apiFetch<AllocationRulesResponse>(`/allocations?${qs.toString()}`);
}

export function getAllocation(ruleId: string): Promise<AllocationRule> {
  return apiFetch<AllocationRule>(`/allocations/${encodeURIComponent(ruleId)}`);
}

export function createAllocation(input: AllocationRuleInput): Promise<AllocationRule> {
  return apiFetch<AllocationRule>('/allocations', {
    method: 'POST',
    body:   JSON.stringify(input),
  });
}

export function updateAllocation(ruleId: string, patch: Partial<AllocationRuleInput>): Promise<AllocationRule> {
  return apiFetch<AllocationRule>(`/allocations/${encodeURIComponent(ruleId)}`, {
    method: 'PUT',
    body:   JSON.stringify(patch),
  });
}

export function archiveAllocation(ruleId: string): Promise<{ ruleId: string; status: string }> {
  return apiFetch(`/allocations/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
}

export function previewAllocation(ruleId: string, period: string): Promise<AllocationPreviewResponse> {
  return apiFetch<AllocationPreviewResponse>(
    `/allocations/${encodeURIComponent(ruleId)}/preview`,
    { method: 'POST', body: JSON.stringify({ period }) },
  );
}

// ── CSV import (Phase 2) ──────────────────────────────────────────────

export type ImportJobStatus = 'PREVIEWED' | 'NO_CHANGES' | 'APPLIED' | 'PARTIAL' | 'FAILED';

export interface ImportPreviewRow {
  row:          number;
  scopeId:      string;
  scopeName:    string;
  period:       string;
  amountUsd:    number;
  granularity:  BudgetGranularity;
  note?:        string;
  currentUsd:   number | null;
  deltaUsd:     number | null;
  changeType:   'create' | 'update' | 'same';
}
export interface ImportErrorRow {
  row:    number;
  field:  string;
  value:  string;
  reason: string;
}
export interface ImportPreviewResponse {
  jobId:       string;
  status:      ImportJobStatus;
  preview:     ImportPreviewRow[];
  errors:      ImportErrorRow[];
  summary:     { creates: number; updates: number; sames: number };
  uploadedAt:  string;
}

export interface ImportCommitResponse {
  jobId:   string;
  status:  ImportJobStatus;
  applied: Array<{ scopeId: string; period: string; version: number; amountUsd: number }>;
  failed:  Array<{ scopeId: string; period: string; reason: string }>;
}

/**
 * Fetch the pre-filled CSV template. Returns raw CSV text (text/csv).
 * The caller turns it into a Blob and offers "Save As…".
 */
export async function downloadBudgetTemplate(): Promise<string> {
  const [token, { apiUrl }] = await Promise.all([
    fetchAuthSession().then((s) => s.tokens?.idToken?.toString() ?? ''),
    getRuntimeConfig(),
  ]);
  if (!token) throw new Error('Not authenticated');
  const resp = await fetch(`${apiUrl}/budgets/template`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Template download failed (${resp.status})`);
  return resp.text();
}

export function importBudgetCsv(csvText: string): Promise<ImportPreviewResponse> {
  return apiFetch<ImportPreviewResponse>('/budgets/import', {
    method: 'POST',
    body:   JSON.stringify({ csv: csvText }),
  });
}

export function getImportPreview(jobId: string): Promise<ImportPreviewResponse & {
  rowCount: number; errorCount: number;
}> {
  return apiFetch(`/budgets/import/${encodeURIComponent(jobId)}`);
}

export function commitImport(jobId: string): Promise<ImportCommitResponse> {
  return apiFetch<ImportCommitResponse>(
    `/budgets/import/${encodeURIComponent(jobId)}/commit`,
    { method: 'POST' },
  );
}

// ── Forecasts & scope actuals ─────────────────────────────────────────

export interface ForecastRecord {
  scopeId:      string;
  period:       string;
  sourceMethod: 'CE_FORECAST' | 'LINEAR' | 'PRIOR_PERIOD' | 'MANUAL';
  amountUsd:    number;
  generatedAt:  string;
  inputs:       Record<string, unknown>;
}

export function listForecasts(scopeId: string, period: string): Promise<{ forecasts: ForecastRecord[] }> {
  return apiFetch(`/forecasts?scopeId=${encodeURIComponent(scopeId)}&period=${encodeURIComponent(period)}`);
}

export function refreshForecast(scopeId: string, period: string): Promise<ForecastRecord> {
  return apiFetch<ForecastRecord>(
    `/forecasts/${encodeURIComponent(scopeId)}/${encodeURIComponent(period)}`,
    { method: 'POST' },
  );
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
