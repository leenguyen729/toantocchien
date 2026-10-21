'use client';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4000';

const TOKEN_KEY = 'pam_session';

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(t: string | null): void {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: session lives in memory only */
  }
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    method: init?.method ?? 'GET',
    headers: { ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
  if (!res.ok) throw new ApiError(json.error?.code ?? 'HTTP_' + res.status, json.error?.message ?? `HTTP ${res.status}`, res.status);
  return json as T;
}

// ---- Shapes returned by apps/api (subset the UI reads).
export type Grant = { role: string; ad_account_ids: string[] | '*'; approval_limit_minor?: number; approval_limit_currency?: string };
export type Me = { actor_id: string; display_name: string; tenant_id: string; kind: string; grants: Grant[] };
export type FreezeState = { frozen: boolean; reason: string | null; changed_by: string | null; changed_at: string | null; stops_running_ads: false };
export type Status = { mode: string; live_writes_enabled: boolean; meta_adapter: string; tenant_id: string; freeze: FreezeState; running_ads_note: string; mock_tools: boolean };
export type Snapshot = { snapshot_id: string; source: string; api_version: string; fetched_at: string; range: { since: string; until: string }; timezone: string; currency: string; attribution: string; completeness: string; missing_fields: string[] };
export type Entity = { entity_id: string; entity_type: string; parent_id: string | null; name: string; status: string; daily_budget_minor: number | null; lifetime_budget_minor: number | null; currency: string; updated_at: string; remote_fingerprint: string };
export type Health = { mode: string; live_writes_enabled: boolean; freeze: FreezeState; pending_approval: number; queued_jobs: number; unknown_or_review: number; open_incidents: number; audit_chain: { ok: boolean; broken_at: number | null; events: number }; running_ads_note: string };
export type Dashboard = {
  ad_account_id: string;
  config: null | { version: string; status: string; account_currency: string; store_currency: string; reporting_timezone: string; account_timezone: string; caps: Record<string, number | null>; max_change_pct: number | null; max_change_amount_minor: number | null; cooldown_seconds: number | null; approval_ttl_seconds: number | null; confirmed_by: string | null };
  snapshots: Snapshot[];
  remote: { source: string; fetched_at: string; entities: Entity[] };
  health: Health | null;
};
export type Action = {
  action_id: string;
  kind: string;
  entity_type: string;
  entity_id?: string;
  local_ref?: string;
  before?: { amount_minor: number; currency: string } | { status: string } | null;
  after?: { amount_minor: number; currency: string } | { status: string };
  depends_on: string[];
  [k: string]: unknown;
};
export type PolicyViolation = { rule_id: string; code: string; message: string; action_id: string | null };
export type Proposal = {
  proposal_id: string;
  revision: number;
  tenant_id: string;
  ad_account_id: string;
  status: string;
  mode: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  payload_hash: string;
  reason: string;
  rollback_plan: string;
  actions: Action[];
  impact: { currency: string; daily_budget_delta_minor: number; lifetime_budget_delta_minor: number; new_daily_budget_minor: number; exposure_minor: number; activates_entities: number; creates_entities: number };
  source_snapshot_ids: string[];
  policy_version: string;
  config_version: string;
};
export type PolicyResult = { decision: 'pass' | 'block'; violations: PolicyViolation[]; warnings: string[]; policy_version: string; evaluated_at: string };
export type Approval = { approval_id: string; actor_id: string; decision: string; decided_at: string; expires_at: string; payload_hash: string; comment: string | null; scope: { ad_account_id: string; exposure_limit_minor: number; currency: string } };
export type ReceiptAction = { action_id: string; kind: string; status: string; remote_id: string | null; local_ref: string | null; error_code: string | null; readback_verified: boolean };
export type Receipt = { receipt_id: string; final_status: string; completed_at: string; simulated: boolean; approval_id: string; actions: ReceiptAction[]; local_ref_map: Record<string, string>; recovery_plan: string[] };
export type AuditEvent = { sequence: number; occurred_at: string; actor_id: string; actor_kind: string; event_type: string; correlation_id: string; summary: string; payload_hash: string; event_hash: string };
export type ProposalDetail = {
  proposal: Proposal;
  policy: PolicyResult | null;
  approvals: Approval[];
  receipt: Receipt | null;
  attempts: { attempt_id: string; action_id: string; status: string; idempotency_tag: string; started_at: string; sanitized_error: { code: string; message: string } | null }[];
  audit: AuditEvent[];
  reservations: unknown[];
  now: string;
};
export type Incident = { incident_id: string; severity: string; state: string; detected_at: string; affected_scope: { components: string[] }; evidence: { note: string }[]; containment: { writes_frozen: boolean; note: string }; resolution: string | null };

export const hasRole = (me: Me | null, ...roles: string[]): boolean => !!me && me.grants.some((g) => roles.includes(g.role));
