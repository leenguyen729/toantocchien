import { DomainError, canonicalHash, type ActionProposal, type ApprovalRecord, type AuditEvent, type BusinessConfig, type DataSnapshot, type ExecutionAttempt, type ExecutionReceipt, type FreezeState, type Incident, type PolicyResult, type ProposalStatus } from '@pod/contracts';
import {
  GENESIS_HASH,
  type AssetRecord,
  type AuditInput,
  type EntityChange,
  type JobRecord,
  type LockGrant,
  type ReservationRecord,
  type ReviewRecord,
  type SessionRecord,
  type Store,
  type VerifiedEntity,
} from './types';

type Data = {
  configs: BusinessConfig[];
  proposals: ActionProposal[];
  policyResults: Map<string, PolicyResult>;
  approvals: ApprovalRecord[];
  jobs: JobRecord[];
  reservations: ReservationRecord[];
  locks: Map<string, LockGrant & { last_token: number }>;
  attempts: ExecutionAttempt[];
  localRefs: Map<string, Record<string, string>>;
  receipts: Map<string, ExecutionReceipt>;
  audit: AuditEvent[];
  freeze: Map<string, FreezeState>;
  incidents: Incident[];
  snapshots: DataSnapshot[];
  reviews: ReviewRecord[];
  assets: AssetRecord[];
  entityChanges: EntityChange[];
  verified: VerifiedEntity[];
  sessions: Map<string, SessionRecord>;
};

const emptyData = (): Data => ({
  configs: [],
  proposals: [],
  policyResults: new Map(),
  approvals: [],
  jobs: [],
  reservations: [],
  locks: new Map(),
  attempts: [],
  localRefs: new Map(),
  receipts: new Map(),
  audit: [],
  freeze: new Map(),
  incidents: [],
  snapshots: [],
  reviews: [],
  assets: [],
  entityChanges: [],
  verified: [],
  sessions: new Map(),
});

const key = (...parts: (string | number)[]): string => parts.join('\u0000');
const clone = <T>(v: T): T => structuredClone(v);

export const UNFROZEN: FreezeState = { frozen: false, reason: null, changed_by: null, changed_at: null, stops_running_ads: false };

export function auditEventHash(e: Omit<AuditEvent, 'event_hash'>): string {
  return canonicalHash(e);
}

/** Simple FIFO async mutex. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Operations on a Data object; no locking. Wrapped by MemoryStore. */
class Ops {
  constructor(public d: Data) {}

  auditAvailable = true;

  async putConfig(cfg: BusinessConfig) {
    if (this.d.configs.some((c) => c.tenant_id === cfg.tenant_id && c.ad_account_id === cfg.ad_account_id && c.version === cfg.version)) {
      throw new DomainError('INPUT_INVALID', `Config version ${cfg.version} đã tồn tại`);
    }
    this.d.configs.push(clone(cfg));
  }
  async getLatestConfig(t: string, a: string) {
    const list = this.d.configs.filter((c) => c.tenant_id === t && c.ad_account_id === a);
    return list.length ? clone(list[list.length - 1]!) : null;
  }
  async getConfigVersion(t: string, a: string, v: string) {
    const c = this.d.configs.find((x) => x.tenant_id === t && x.ad_account_id === a && x.version === v);
    return c ? clone(c) : null;
  }
  async listConfigVersions(t: string, a: string) {
    return clone(this.d.configs.filter((c) => c.tenant_id === t && c.ad_account_id === a));
  }

  async insertProposal(p: ActionProposal) {
    if (this.d.proposals.some((x) => x.tenant_id === p.tenant_id && x.proposal_id === p.proposal_id && x.revision === p.revision)) {
      throw new DomainError('INPUT_INVALID', 'Proposal revision đã tồn tại');
    }
    this.d.proposals.push(clone(p));
  }
  private findProposal(t: string, id: string, rev: number) {
    return this.d.proposals.find((x) => x.tenant_id === t && x.proposal_id === id && x.revision === rev);
  }
  async getProposal(t: string, id: string, rev: number) {
    const p = this.findProposal(t, id, rev);
    return p ? clone(p) : null;
  }
  async getLatestProposal(t: string, id: string) {
    const list = this.d.proposals.filter((x) => x.tenant_id === t && x.proposal_id === id).sort((a, b) => b.revision - a.revision);
    return list[0] ? clone(list[0]) : null;
  }
  async listProposals(t: string, f: { statuses?: ProposalStatus[]; ad_account_id?: string } = {}) {
    return clone(
      this.d.proposals
        .filter((p) => p.tenant_id === t && (!f.statuses || f.statuses.includes(p.status)) && (!f.ad_account_id || p.ad_account_id === f.ad_account_id))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
    );
  }
  async casProposalStatus(t: string, id: string, rev: number, from: ProposalStatus, to: ProposalStatus) {
    const p = this.findProposal(t, id, rev);
    if (!p || p.status !== from) return false;
    p.status = to;
    return true;
  }
  async putPolicyResult(t: string, id: string, rev: number, r: PolicyResult) {
    this.d.policyResults.set(key(t, id, rev), clone(r));
  }
  async getPolicyResult(t: string, id: string, rev: number) {
    const r = this.d.policyResults.get(key(t, id, rev));
    return r ? clone(r) : null;
  }

  async insertApproval(a: ApprovalRecord) {
    this.d.approvals.push(clone(a));
  }
  async listApprovals(t: string, id: string, rev: number) {
    return clone(this.d.approvals.filter((a) => a.tenant_id === t && a.proposal_id === id && a.revision === rev));
  }

  async insertJob(j: JobRecord) {
    this.d.jobs.push(clone(j));
  }
  async leaseNextJob(now: string, leaseMs: number, owner: string) {
    const j = this.d.jobs
      .filter((x) => (x.status === 'pending' && x.available_at <= now) || (x.status === 'leased' && x.lease_until !== null && x.lease_until <= now))
      .sort((a, b) => (a.available_at < b.available_at ? -1 : 1))[0];
    if (!j) return null;
    j.status = 'leased';
    j.lease_owner = owner;
    j.lease_until = new Date(Date.parse(now) + leaseMs).toISOString();
    j.attempts++;
    return clone(j);
  }
  async getJob(id: string) {
    const j = this.d.jobs.find((x) => x.job_id === id);
    return j ? clone(j) : null;
  }
  async completeJob(id: string, owner: string, status: 'done' | 'dead', error: string | null = null) {
    const j = this.d.jobs.find((x) => x.job_id === id);
    if (!j || j.lease_owner !== owner || j.status !== 'leased') return false;
    j.status = status;
    j.last_error = error;
    j.lease_until = null;
    return true;
  }
  async releaseJob(id: string, owner: string, availableAt: string, error: string | null) {
    const j = this.d.jobs.find((x) => x.job_id === id);
    if (!j || j.lease_owner !== owner || j.status !== 'leased') return false;
    j.status = 'pending';
    j.available_at = availableAt;
    j.lease_owner = null;
    j.lease_until = null;
    j.last_error = error;
    return true;
  }
  async countJobs(t: string, statuses: JobRecord['status'][]) {
    return this.d.jobs.filter((j) => j.tenant_id === t && statuses.includes(j.status)).length;
  }

  async lockBudgetScope(_t: string, _a: string) {
    // The store-wide mutex already serialises transactions.
  }
  async insertReservation(r: ReservationRecord) {
    this.d.reservations.push(clone(r));
  }
  async sumActiveReservations(t: string, a: string, exclude?: { proposal_id: string; revision: number }) {
    let daily = 0;
    let lifetime = 0;
    for (const r of this.d.reservations) {
      if (r.tenant_id !== t || r.ad_account_id !== a || r.status !== 'active') continue;
      if (exclude && r.proposal_id === exclude.proposal_id && r.revision === exclude.revision) continue;
      daily += r.daily_minor;
      lifetime += r.lifetime_minor;
    }
    return { daily_minor: daily, lifetime_minor: lifetime };
  }
  async releaseReservations(t: string, id: string, rev: number, at: string) {
    for (const r of this.d.reservations) {
      if (r.tenant_id === t && r.proposal_id === id && r.revision === rev && r.status === 'active') {
        r.status = 'released';
        r.released_at = at;
      }
    }
  }
  async listReservations(t: string, id: string, rev: number) {
    return clone(this.d.reservations.filter((r) => r.tenant_id === t && r.proposal_id === id && r.revision === rev));
  }

  async acquireLock(scope: string, holder: string, now: string, ttlMs: number) {
    const cur = this.d.locks.get(scope);
    if (cur && cur.expires_at > now && cur.holder !== holder) return null;
    const token = (cur?.last_token ?? 0) + 1;
    const grant = { scope, holder, token, expires_at: new Date(Date.parse(now) + ttlMs).toISOString() };
    this.d.locks.set(scope, { ...grant, last_token: token });
    return { ...grant };
  }
  async isFenceValid(scope: string, token: number, now: string) {
    const cur = this.d.locks.get(scope);
    return !!cur && cur.token === token && cur.expires_at > now;
  }
  async releaseLock(scope: string, holder: string, token: number) {
    const cur = this.d.locks.get(scope);
    if (cur && cur.holder === holder && cur.token === token) {
      cur.expires_at = new Date(0).toISOString();
    }
  }

  async getAttemptByKey(t: string, k: string) {
    const a = this.d.attempts.find((x) => x.tenant_id === t && x.idempotency_key === k);
    return a ? clone(a) : null;
  }
  private async checkFence(a: ExecutionAttempt, fence: { scope: string; now: string }) {
    if (!(await this.isFenceValid(fence.scope, a.fencing_token, fence.now))) {
      throw new DomainError('REMOTE_UNKNOWN', 'Fencing token đã cũ: worker khác đang giữ khóa');
    }
  }
  async insertAttempt(a: ExecutionAttempt, fence: { scope: string; now: string } | null) {
    if (fence) await this.checkFence(a, fence);
    if (this.d.attempts.some((x) => x.tenant_id === a.tenant_id && x.idempotency_key === a.idempotency_key)) {
      throw new DomainError('INPUT_INVALID', 'Idempotency key đã tồn tại');
    }
    this.d.attempts.push(clone(a));
  }
  async updateAttempt(a: ExecutionAttempt, fence: { scope: string; now: string } | null) {
    if (fence) await this.checkFence(a, fence);
    const i = this.d.attempts.findIndex((x) => x.tenant_id === a.tenant_id && x.attempt_id === a.attempt_id);
    if (i < 0) throw new DomainError('INPUT_INVALID', 'Attempt không tồn tại');
    this.d.attempts[i] = clone(a);
  }
  async listAttempts(t: string, id: string, rev: number) {
    return clone(this.d.attempts.filter((a) => a.tenant_id === t && a.proposal_id === id && a.revision === rev));
  }

  async putLocalRef(t: string, id: string, rev: number, ref: string, remote: string) {
    const k = key(t, id, rev);
    const m = this.d.localRefs.get(k) ?? {};
    m[ref] = remote;
    this.d.localRefs.set(k, m);
  }
  async getLocalRefs(t: string, id: string, rev: number) {
    return clone(this.d.localRefs.get(key(t, id, rev)) ?? {});
  }

  async putReceipt(r: ExecutionReceipt) {
    this.d.receipts.set(key(r.tenant_id, r.proposal_id, r.revision), clone(r));
  }
  async getReceipt(t: string, id: string, rev: number) {
    const r = this.d.receipts.get(key(t, id, rev));
    return r ? clone(r) : null;
  }

  async appendAudit(e: AuditInput) {
    if (!this.auditAvailable) throw new DomainError('WRITE_FROZEN', 'Audit store không khả dụng: từ chối ghi (fail-closed)');
    const prev = [...this.d.audit].reverse().find((x) => x.tenant_id === e.tenant_id);
    const base = { ...e, sequence: (prev?.sequence ?? 0) + 1, prev_hash: prev?.event_hash ?? GENESIS_HASH };
    const event: AuditEvent = { ...base, event_hash: auditEventHash(base) };
    this.d.audit.push(Object.freeze(clone(event)));
    return clone(event);
  }
  async listAudit(t: string, f: { correlation_id?: string; limit?: number } = {}) {
    const list = this.d.audit.filter((e) => e.tenant_id === t && (!f.correlation_id || e.correlation_id === f.correlation_id));
    return clone(f.limit ? list.slice(-f.limit) : list);
  }

  async getFreeze(t: string) {
    return clone(this.d.freeze.get(t) ?? UNFROZEN);
  }
  async setFreeze(t: string, s: FreezeState) {
    this.d.freeze.set(t, clone(s));
  }
  async insertIncident(i: Incident) {
    this.d.incidents.push(clone(i));
  }
  async updateIncident(i: Incident) {
    const idx = this.d.incidents.findIndex((x) => x.tenant_id === i.tenant_id && x.incident_id === i.incident_id);
    if (idx < 0) throw new DomainError('INPUT_INVALID', 'Incident không tồn tại');
    this.d.incidents[idx] = clone(i);
  }
  async listIncidents(t: string) {
    return clone(this.d.incidents.filter((i) => i.tenant_id === t));
  }
  async getIncident(t: string, id: string) {
    const i = this.d.incidents.find((x) => x.tenant_id === t && x.incident_id === id);
    return i ? clone(i) : null;
  }

  async putSnapshot(s: DataSnapshot) {
    this.d.snapshots = this.d.snapshots.filter((x) => !(x.tenant_id === s.tenant_id && x.snapshot_id === s.snapshot_id));
    this.d.snapshots.push(clone(s));
  }
  async getSnapshots(t: string, ids: string[]) {
    return clone(this.d.snapshots.filter((s) => s.tenant_id === t && ids.includes(s.snapshot_id)));
  }
  async listSnapshots(t: string) {
    return clone(this.d.snapshots.filter((s) => s.tenant_id === t));
  }
  async putReview(r: ReviewRecord) {
    this.d.reviews = this.d.reviews.filter((x) => !(x.tenant_id === r.tenant_id && x.review_id === r.review_id));
    this.d.reviews.push(clone(r));
  }
  async getReviews(t: string, ids: string[]) {
    return clone(this.d.reviews.filter((r) => r.tenant_id === t && ids.includes(r.review_id)));
  }
  async putAsset(a: AssetRecord) {
    this.d.assets = this.d.assets.filter((x) => !(x.tenant_id === a.tenant_id && x.asset_id === a.asset_id));
    this.d.assets.push(clone(a));
  }
  async getAssets(t: string, ids: string[]) {
    return clone(this.d.assets.filter((a) => a.tenant_id === t && ids.includes(a.asset_id)));
  }

  async recordEntityChange(c: EntityChange) {
    this.d.entityChanges.push(clone(c));
  }
  async lastEntityChanges(t: string, a: string) {
    const m = new Map<string, string>();
    for (const c of this.d.entityChanges) {
      if (c.tenant_id !== t || c.ad_account_id !== a) continue;
      const prev = m.get(c.entity_id);
      if (!prev || prev < c.changed_at) m.set(c.entity_id, c.changed_at);
    }
    return m;
  }
  async addVerifiedEntity(v: VerifiedEntity) {
    this.d.verified.push(clone(v));
  }
  async listVerifiedEntities(t: string, a: string) {
    return new Set(this.d.verified.filter((v) => v.tenant_id === t && v.ad_account_id === a).map((v) => v.entity_id));
  }

  async putSession(s: SessionRecord) {
    this.d.sessions.set(s.token_hash, clone(s));
  }
  async getSession(h: string) {
    const s = this.d.sessions.get(h);
    return s ? clone(s) : null;
  }
}

/**
 * In-memory Store used by the zero-dependency demo and unit tests. Every call
 * is serialised through a mutex; tx() snapshots state and restores it if fn
 * throws, so tests see real rollback semantics.
 */
export class MemoryStore implements Store {
  private readonly mutex = new Mutex();
  private readonly ops = new Ops(emptyData());

  /** Test hook: simulate audit storage outage (all audited writes must then fail closed). */
  setAuditAvailable(v: boolean): void {
    this.ops.auditAvailable = v;
  }

  /** Backup/restore drill helpers. Restore always comes back frozen so nothing replays before reconciliation. */
  exportState(): string {
    return JSON.stringify(this.ops.d, (_k, v) => (v instanceof Map ? { __map: [...v.entries()] } : v));
  }
  importState(serialised: string, restoredAt: string): void {
    const d = JSON.parse(serialised, (_k, v) => (v && typeof v === 'object' && '__map' in v ? new Map(v.__map) : v)) as Data;
    const tenants = new Set<string>([...d.configs.map((c) => c.tenant_id), ...d.proposals.map((p) => p.tenant_id)]);
    for (const t of tenants) {
      d.freeze.set(t, { frozen: true, reason: 'Khôi phục từ backup: cần reconcile trước khi mở lại ghi', changed_by: 'system', changed_at: restoredAt, stops_running_ads: false });
    }
    this.ops.d = d;
  }

  tx<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      const backup = structuredClone(this.ops.d);
      const view = this.view();
      try {
        return await fn(view);
      } catch (e) {
        this.ops.d = backup;
        throw e;
      }
    });
  }

  /** Unlocked view bound to current data (used inside tx). */
  private view(): Store {
    const ops = this.ops;
    const v = new Proxy({} as Store, {
      get: (_t, prop: string) => {
        if (prop === 'tx') return <T>(fn: (s: Store) => Promise<T>) => fn(v);
        const m = (ops as unknown as Record<string, unknown>)[prop];
        return typeof m === 'function' ? (m as (...a: unknown[]) => unknown).bind(ops) : m;
      },
    });
    return v;
  }

  private call<K extends keyof Ops & keyof Store>(name: K, args: unknown[]): ReturnType<Store[K]> {
    return this.mutex.run(() => (this.ops[name] as (...a: unknown[]) => Promise<unknown>).apply(this.ops, args)) as ReturnType<Store[K]>;
  }

  putConfig(...a: Parameters<Store['putConfig']>) { return this.call('putConfig', a); }
  getLatestConfig(...a: Parameters<Store['getLatestConfig']>) { return this.call('getLatestConfig', a); }
  getConfigVersion(...a: Parameters<Store['getConfigVersion']>) { return this.call('getConfigVersion', a); }
  listConfigVersions(...a: Parameters<Store['listConfigVersions']>) { return this.call('listConfigVersions', a); }
  insertProposal(...a: Parameters<Store['insertProposal']>) { return this.call('insertProposal', a); }
  getProposal(...a: Parameters<Store['getProposal']>) { return this.call('getProposal', a); }
  getLatestProposal(...a: Parameters<Store['getLatestProposal']>) { return this.call('getLatestProposal', a); }
  listProposals(...a: Parameters<Store['listProposals']>) { return this.call('listProposals', a); }
  casProposalStatus(...a: Parameters<Store['casProposalStatus']>) { return this.call('casProposalStatus', a); }
  putPolicyResult(...a: Parameters<Store['putPolicyResult']>) { return this.call('putPolicyResult', a); }
  getPolicyResult(...a: Parameters<Store['getPolicyResult']>) { return this.call('getPolicyResult', a); }
  insertApproval(...a: Parameters<Store['insertApproval']>) { return this.call('insertApproval', a); }
  listApprovals(...a: Parameters<Store['listApprovals']>) { return this.call('listApprovals', a); }
  insertJob(...a: Parameters<Store['insertJob']>) { return this.call('insertJob', a); }
  leaseNextJob(...a: Parameters<Store['leaseNextJob']>) { return this.call('leaseNextJob', a); }
  getJob(...a: Parameters<Store['getJob']>) { return this.call('getJob', a); }
  completeJob(...a: Parameters<Store['completeJob']>) { return this.call('completeJob', a); }
  releaseJob(...a: Parameters<Store['releaseJob']>) { return this.call('releaseJob', a); }
  countJobs(...a: Parameters<Store['countJobs']>) { return this.call('countJobs', a); }
  lockBudgetScope(...a: Parameters<Store['lockBudgetScope']>) { return this.call('lockBudgetScope', a); }
  insertReservation(...a: Parameters<Store['insertReservation']>) { return this.call('insertReservation', a); }
  sumActiveReservations(...a: Parameters<Store['sumActiveReservations']>) { return this.call('sumActiveReservations', a); }
  releaseReservations(...a: Parameters<Store['releaseReservations']>) { return this.call('releaseReservations', a); }
  listReservations(...a: Parameters<Store['listReservations']>) { return this.call('listReservations', a); }
  acquireLock(...a: Parameters<Store['acquireLock']>) { return this.call('acquireLock', a); }
  isFenceValid(...a: Parameters<Store['isFenceValid']>) { return this.call('isFenceValid', a); }
  releaseLock(...a: Parameters<Store['releaseLock']>) { return this.call('releaseLock', a); }
  getAttemptByKey(...a: Parameters<Store['getAttemptByKey']>) { return this.call('getAttemptByKey', a); }
  insertAttempt(...a: Parameters<Store['insertAttempt']>) { return this.call('insertAttempt', a); }
  updateAttempt(...a: Parameters<Store['updateAttempt']>) { return this.call('updateAttempt', a); }
  listAttempts(...a: Parameters<Store['listAttempts']>) { return this.call('listAttempts', a); }
  putLocalRef(...a: Parameters<Store['putLocalRef']>) { return this.call('putLocalRef', a); }
  getLocalRefs(...a: Parameters<Store['getLocalRefs']>) { return this.call('getLocalRefs', a); }
  putReceipt(...a: Parameters<Store['putReceipt']>) { return this.call('putReceipt', a); }
  getReceipt(...a: Parameters<Store['getReceipt']>) { return this.call('getReceipt', a); }
  appendAudit(...a: Parameters<Store['appendAudit']>) { return this.call('appendAudit', a); }
  listAudit(...a: Parameters<Store['listAudit']>) { return this.call('listAudit', a); }
  getFreeze(...a: Parameters<Store['getFreeze']>) { return this.call('getFreeze', a); }
  setFreeze(...a: Parameters<Store['setFreeze']>) { return this.call('setFreeze', a); }
  insertIncident(...a: Parameters<Store['insertIncident']>) { return this.call('insertIncident', a); }
  updateIncident(...a: Parameters<Store['updateIncident']>) { return this.call('updateIncident', a); }
  listIncidents(...a: Parameters<Store['listIncidents']>) { return this.call('listIncidents', a); }
  getIncident(...a: Parameters<Store['getIncident']>) { return this.call('getIncident', a); }
  putSnapshot(...a: Parameters<Store['putSnapshot']>) { return this.call('putSnapshot', a); }
  getSnapshots(...a: Parameters<Store['getSnapshots']>) { return this.call('getSnapshots', a); }
  listSnapshots(...a: Parameters<Store['listSnapshots']>) { return this.call('listSnapshots', a); }
  putReview(...a: Parameters<Store['putReview']>) { return this.call('putReview', a); }
  getReviews(...a: Parameters<Store['getReviews']>) { return this.call('getReviews', a); }
  putAsset(...a: Parameters<Store['putAsset']>) { return this.call('putAsset', a); }
  getAssets(...a: Parameters<Store['getAssets']>) { return this.call('getAssets', a); }
  recordEntityChange(...a: Parameters<Store['recordEntityChange']>) { return this.call('recordEntityChange', a); }
  lastEntityChanges(...a: Parameters<Store['lastEntityChanges']>) { return this.call('lastEntityChanges', a); }
  addVerifiedEntity(...a: Parameters<Store['addVerifiedEntity']>) { return this.call('addVerifiedEntity', a); }
  listVerifiedEntities(...a: Parameters<Store['listVerifiedEntities']>) { return this.call('listVerifiedEntities', a); }
  putSession(...a: Parameters<Store['putSession']>) { return this.call('putSession', a); }
  getSession(...a: Parameters<Store['getSession']>) { return this.call('getSession', a); }
}
