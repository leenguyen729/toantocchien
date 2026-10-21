import type {
  ActionProposal,
  ApprovalRecord,
  AuditEvent,
  BusinessConfig,
  CreativeAsset,
  DataSnapshot,
  ExecutionAttempt,
  ExecutionReceipt,
  FreezeState,
  Incident,
  PolicyResult,
  ProposalStatus,
} from '@pod/contracts';
import type { CreativeReview } from '@pod/policy';
import type { Principal } from '../rbac';

export type JobRecord = {
  job_id: string;
  tenant_id: string;
  proposal_id: string;
  revision: number;
  kind: 'execute' | 'reconcile';
  status: 'pending' | 'leased' | 'done' | 'dead';
  attempts: number;
  available_at: string;
  lease_owner: string | null;
  lease_until: string | null;
  created_at: string;
  last_error: string | null;
};

export type ReservationRecord = {
  reservation_id: string;
  tenant_id: string;
  ad_account_id: string;
  proposal_id: string;
  revision: number;
  daily_minor: number;
  lifetime_minor: number;
  currency: string;
  status: 'active' | 'released';
  created_at: string;
  released_at: string | null;
};

export type LockGrant = { scope: string; holder: string; token: number; expires_at: string };

export type SessionRecord = { token_hash: string; principal: Principal; expires_at: string };

export type AuditInput = Omit<AuditEvent, 'sequence' | 'prev_hash' | 'event_hash'>;

export type EntityChange = { tenant_id: string; ad_account_id: string; entity_id: string; changed_at: string; proposal_id: string };

export type VerifiedEntity = { tenant_id: string; ad_account_id: string; entity_id: string; proposal_id: string; verified_at: string };

export type ReviewRecord = CreativeReview & { tenant_id: string };
export type AssetRecord = CreativeAsset & { tenant_id: string };

/**
 * Persistence port. Every method that touches business data takes tenantId and
 * implementations MUST filter by it. Audit is append-only: there is no update
 * or delete method, and implementations must refuse writes when audit storage
 * is unavailable (callers wrap state changes and audit in one tx).
 */
export interface Store {
  /** Run fn atomically. Nested calls join the outer transaction. */
  tx<T>(fn: (s: Store) => Promise<T>): Promise<T>;

  // Business config (immutable versions)
  putConfig(cfg: BusinessConfig): Promise<void>;
  getLatestConfig(tenantId: string, adAccountId: string): Promise<BusinessConfig | null>;
  getConfigVersion(tenantId: string, adAccountId: string, version: string): Promise<BusinessConfig | null>;
  listConfigVersions(tenantId: string, adAccountId: string): Promise<BusinessConfig[]>;

  // Proposals (each revision immutable except status via compare-and-set)
  insertProposal(p: ActionProposal): Promise<void>;
  getProposal(tenantId: string, proposalId: string, revision: number): Promise<ActionProposal | null>;
  getLatestProposal(tenantId: string, proposalId: string): Promise<ActionProposal | null>;
  listProposals(tenantId: string, filter?: { statuses?: ProposalStatus[]; ad_account_id?: string }): Promise<ActionProposal[]>;
  casProposalStatus(tenantId: string, proposalId: string, revision: number, from: ProposalStatus, to: ProposalStatus): Promise<boolean>;
  putPolicyResult(tenantId: string, proposalId: string, revision: number, r: PolicyResult): Promise<void>;
  getPolicyResult(tenantId: string, proposalId: string, revision: number): Promise<PolicyResult | null>;

  // Approvals
  insertApproval(a: ApprovalRecord): Promise<void>;
  listApprovals(tenantId: string, proposalId: string, revision: number): Promise<ApprovalRecord[]>;

  // Outbox jobs. leaseNextJob is the only cross-tenant read: the worker then scopes by job.tenant_id.
  insertJob(j: JobRecord): Promise<void>;
  leaseNextJob(now: string, leaseMs: number, owner: string): Promise<JobRecord | null>;
  getJob(jobId: string): Promise<JobRecord | null>;
  completeJob(jobId: string, owner: string, status: 'done' | 'dead', error?: string | null): Promise<boolean>;
  releaseJob(jobId: string, owner: string, availableAt: string, error: string | null): Promise<boolean>;
  countJobs(tenantId: string, statuses: JobRecord['status'][]): Promise<number>;

  // Budget reservations. lockBudgetScope serialises cap checks for one account inside a tx.
  lockBudgetScope(tenantId: string, adAccountId: string): Promise<void>;
  insertReservation(r: ReservationRecord): Promise<void>;
  sumActiveReservations(tenantId: string, adAccountId: string, exclude?: { proposal_id: string; revision: number }): Promise<{ daily_minor: number; lifetime_minor: number }>;
  releaseReservations(tenantId: string, proposalId: string, revision: number, at: string): Promise<void>;
  listReservations(tenantId: string, proposalId: string, revision: number): Promise<ReservationRecord[]>;

  // Locks with fencing tokens (monotonic per scope)
  acquireLock(scope: string, holder: string, now: string, ttlMs: number): Promise<LockGrant | null>;
  isFenceValid(scope: string, token: number, now: string): Promise<boolean>;
  releaseLock(scope: string, holder: string, token: number): Promise<void>;

  // Idempotency ledger
  getAttemptByKey(tenantId: string, idempotencyKey: string): Promise<ExecutionAttempt | null>;
  /**
   * Throws if the key already exists or the fence is stale. `fence` may be null
   * only for rows that record that nothing was sent (skipped).
   */
  insertAttempt(a: ExecutionAttempt, fence: { scope: string; now: string } | null): Promise<void>;
  updateAttempt(a: ExecutionAttempt, fence: { scope: string; now: string } | null): Promise<void>;
  listAttempts(tenantId: string, proposalId: string, revision: number): Promise<ExecutionAttempt[]>;

  putLocalRef(tenantId: string, proposalId: string, revision: number, localRef: string, remoteId: string): Promise<void>;
  getLocalRefs(tenantId: string, proposalId: string, revision: number): Promise<Record<string, string>>;

  putReceipt(r: ExecutionReceipt): Promise<void>;
  getReceipt(tenantId: string, proposalId: string, revision: number): Promise<ExecutionReceipt | null>;

  // Audit (append-only, hash-chained per tenant)
  appendAudit(e: AuditInput): Promise<AuditEvent>;
  listAudit(tenantId: string, filter?: { correlation_id?: string; limit?: number }): Promise<AuditEvent[]>;

  // Ops
  getFreeze(tenantId: string): Promise<FreezeState>;
  setFreeze(tenantId: string, s: FreezeState): Promise<void>;
  insertIncident(i: Incident): Promise<void>;
  updateIncident(i: Incident): Promise<void>;
  listIncidents(tenantId: string): Promise<Incident[]>;
  getIncident(tenantId: string, incidentId: string): Promise<Incident | null>;

  // Data and creative registries
  putSnapshot(s: DataSnapshot): Promise<void>;
  getSnapshots(tenantId: string, ids: string[]): Promise<DataSnapshot[]>;
  listSnapshots(tenantId: string): Promise<DataSnapshot[]>;
  putReview(r: ReviewRecord): Promise<void>;
  getReviews(tenantId: string, ids: string[]): Promise<ReviewRecord[]>;
  putAsset(a: AssetRecord): Promise<void>;
  getAssets(tenantId: string, ids: string[]): Promise<AssetRecord[]>;

  recordEntityChange(c: EntityChange): Promise<void>;
  lastEntityChanges(tenantId: string, adAccountId: string): Promise<Map<string, string>>;
  addVerifiedEntity(v: VerifiedEntity): Promise<void>;
  listVerifiedEntities(tenantId: string, adAccountId: string): Promise<Set<string>>;

  // Sessions (token stored as hash only)
  putSession(s: SessionRecord): Promise<void>;
  getSession(tokenHash: string): Promise<SessionRecord | null>;
}

export const GENESIS_HASH = '0'.repeat(64);
