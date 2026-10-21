import { DomainError, type Role } from '@pod/contracts';

export type Grant = {
  role: Role;
  /** Ad accounts in scope for this grant. '*' = every account of the tenant. */
  ad_account_ids: string[] | '*';
  /** Approvers only: maximum proposal exposure they may approve. */
  approval_limit_minor?: number;
  approval_limit_currency?: string;
};

/**
 * Authenticated actor, always resolved server-side from a session or service
 * credential. Tenant/role claims inside tool inputs or model output are ignored.
 */
export type Principal = {
  actor_id: string;
  tenant_id: string;
  kind: 'human' | 'llm' | 'service';
  display_name: string;
  grants: Grant[];
};

export type Permission =
  | 'report.read'
  | 'audit.read'
  | 'config.read'
  | 'config.save_draft'
  | 'config.confirm'
  | 'proposal.create'
  | 'proposal.cancel'
  | 'proposal.approve'
  | 'execution.request'
  | 'execution.reconcile'
  | 'ops.health'
  | 'ops.freeze'
  | 'ops.unfreeze'
  | 'ops.incident.create'
  | 'ops.incident.update'
  | 'connections.manage';

const ALL: Role[] = ['viewer', 'analyst', 'approver', 'operator', 'owner'];

const ROLE_PERMISSIONS: Record<Permission, Role[]> = {
  'report.read': ALL,
  'audit.read': ['analyst', 'approver', 'operator', 'owner'],
  'config.read': ALL,
  'config.save_draft': ['analyst', 'owner'],
  'config.confirm': ['owner'],
  'proposal.create': ['analyst', 'owner'],
  'proposal.cancel': ['analyst', 'owner'],
  // Operator and owner do not implicitly approve. Only an explicit approver grant does.
  'proposal.approve': ['approver'],
  'execution.request': ['analyst', 'approver', 'owner'],
  'execution.reconcile': ['analyst', 'approver', 'operator', 'owner'],
  'ops.health': ['analyst', 'approver', 'operator', 'owner'],
  'ops.freeze': ['operator', 'owner'],
  'ops.unfreeze': ['owner'],
  'ops.incident.create': ['analyst', 'operator', 'owner'],
  'ops.incident.update': ['operator', 'owner'],
  'connections.manage': ['operator', 'owner'],
};

/** Never granted to an LLM or service principal, whatever grants it carries. */
const HUMAN_ONLY: ReadonlySet<Permission> = new Set<Permission>(['proposal.approve', 'config.confirm', 'ops.unfreeze', 'connections.manage']);

/** Upper bound for the Claude runtime principal. Freezing is allowed because it only fails closed. */
const LLM_ALLOWED: ReadonlySet<Permission> = new Set<Permission>([
  'report.read',
  'audit.read',
  'config.read',
  'config.save_draft',
  'proposal.create',
  'execution.request',
  'execution.reconcile',
  'ops.health',
  'ops.freeze',
  'ops.incident.create',
]);

function grantCovers(g: Grant, accountId: string | null): boolean {
  return accountId === null || g.ad_account_ids === '*' || g.ad_account_ids.includes(accountId);
}

export function matchingGrants(p: Principal, perm: Permission, accountId: string | null): Grant[] {
  if (HUMAN_ONLY.has(perm) && p.kind !== 'human') return [];
  if (p.kind === 'llm' && !LLM_ALLOWED.has(perm)) return [];
  if (p.kind === 'llm' && perm === 'ops.freeze') return p.grants.filter((g) => grantCovers(g, accountId));
  return p.grants.filter((g) => ROLE_PERMISSIONS[perm].includes(g.role) && grantCovers(g, accountId));
}

export function can(p: Principal, perm: Permission, accountId: string | null = null): boolean {
  return matchingGrants(p, perm, accountId).length > 0;
}

export function assertCan(p: Principal, perm: Permission, accountId: string | null = null): void {
  if (!can(p, perm, accountId)) {
    throw new DomainError('PERMISSION_DENIED', `Không có quyền ${perm}${accountId ? ` trên ${accountId}` : ''}`);
  }
}

/** Tenant id in any input must equal the authenticated principal's tenant. Input never grants access. */
export function assertTenant(p: Principal, tenantId: string): void {
  if (p.tenant_id !== tenantId) throw new DomainError('TENANT_MISMATCH', 'tenant_id không khớp phiên đăng nhập');
}
