import type { RemoteEntity } from '@pod/contracts';
import { AdapterError, tagSuffix, type CapabilityInfo, type CreateRequest, type MetaWriteAdapter, type UpdateRequest } from './types';

export type FaultKind =
  | 'rate_limit'
  | 'auth_error'
  | 'validation_error'
  | 'timeout_before_commit'
  | 'timeout_after_commit'
  | 'duplicate_commit'
  | 'not_found';

export type FaultRule = {
  op: 'create' | 'update' | 'read';
  fault: FaultKind;
  /** Optional filter, e.g. only the second create. */
  match?: (req: CreateRequest | UpdateRequest | { entity_id: string }) => boolean;
  times?: number;
};

export type FakeMetaOptions = {
  now?: () => Date;
  /** Writes allowed per quota window before RATE_LIMITED. */
  writeQuota?: number;
  capabilities?: CapabilityInfo;
};

/**
 * In-memory simulator of the Meta write surface used in mock mode and tests.
 * It is NOT a model of real Meta semantics beyond what our contracts need:
 * entities, budgets, statuses, quota, and failure injection.
 */
export class FakeMetaAdapter implements MetaWriteAdapter {
  readonly kind = 'mock' as const;
  private readonly entities = new Map<string, Map<string, RemoteEntity>>();
  private faults: (FaultRule & { remaining: number })[] = [];
  private seq = 0;
  private writesInWindow = 0;
  /** Every mutation that reached the simulator, committed or not. Used to prove "zero outbound writes". */
  readonly outboundWrites: { op: 'create' | 'update'; accountId: string; at: string; committed: boolean }[] = [];
  private readonly now: () => Date;
  private readonly writeQuota: number;
  private readonly caps: CapabilityInfo;

  constructor(opts: FakeMetaOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.writeQuota = opts.writeQuota ?? 1000;
    this.caps = opts.capabilities ?? MOCK_CAPABILITIES;
  }

  seed(accountId: string, list: RemoteEntity[]): void {
    const m = this.account(accountId);
    for (const e of list) m.set(e.entity_id, structuredClone(e));
  }

  inject(rule: FaultRule): void {
    this.faults.push({ ...rule, remaining: rule.times ?? 1 });
  }

  resetQuotaWindow(): void {
    this.writesInWindow = 0;
  }

  private account(id: string): Map<string, RemoteEntity> {
    let m = this.entities.get(id);
    if (!m) {
      m = new Map();
      this.entities.set(id, m);
    }
    return m;
  }

  private takeFault(op: FaultRule['op'], req: CreateRequest | UpdateRequest | { entity_id: string }): FaultKind | null {
    const i = this.faults.findIndex((f) => f.op === op && f.remaining > 0 && (!f.match || f.match(req)));
    if (i < 0) return null;
    const f = this.faults[i]!;
    f.remaining--;
    if (f.remaining === 0) this.faults.splice(i, 1);
    return f.fault;
  }

  private throwFor(fault: FaultKind): never {
    switch (fault) {
      case 'rate_limit':
        throw new AdapterError('rate_limited', 'Mock: rate limited', 1000);
      case 'auth_error':
        throw new AdapterError('auth', 'Mock: token invalid or revoked');
      case 'validation_error':
        throw new AdapterError('validation', 'Mock: request rejected by validation');
      case 'not_found':
        throw new AdapterError('not_found', 'Mock: entity not found');
      default:
        throw new AdapterError('timeout', 'Mock: request timed out');
    }
  }

  async listEntities(accountId: string): Promise<RemoteEntity[]> {
    const fault = this.takeFault('read', { entity_id: '*' });
    if (fault) this.throwFor(fault);
    return [...this.account(accountId).values()].map((e) => structuredClone(e));
  }

  async getEntity(accountId: string, entityId: string): Promise<RemoteEntity | null> {
    const fault = this.takeFault('read', { entity_id: entityId });
    if (fault) this.throwFor(fault);
    const e = this.account(accountId).get(entityId);
    return e ? structuredClone(e) : null;
  }

  async findByIdempotencyTag(accountId: string, tag: string): Promise<RemoteEntity[]> {
    const suffix = tagSuffix(tag);
    return [...this.account(accountId).values()].filter((e) => e.name.endsWith(suffix)).map((e) => structuredClone(e));
  }

  async capabilities(): Promise<CapabilityInfo> {
    return structuredClone(this.caps);
  }

  private checkQuota(): void {
    if (this.writesInWindow >= this.writeQuota) throw new AdapterError('rate_limited', 'Mock: write quota exhausted', 60_000);
    this.writesInWindow++;
  }

  async create(accountId: string, req: CreateRequest): Promise<{ remote_id: string; remote_request_id: string }> {
    const fault = this.takeFault('create', req);
    const at = this.now().toISOString();
    if (fault === 'rate_limit' || fault === 'auth_error' || fault === 'validation_error' || fault === 'timeout_before_commit') {
      this.outboundWrites.push({ op: 'create', accountId, at, committed: false });
      this.throwFor(fault);
    }
    this.checkQuota();
    const m = this.account(accountId);
    if (req.parent_id !== null && !m.has(req.parent_id)) {
      this.outboundWrites.push({ op: 'create', accountId, at, committed: false });
      throw new AdapterError('validation', 'Mock: parent does not exist');
    }
    const commit = (): string => {
      const id = `mock_${req.entity_type}_${++this.seq}`;
      m.set(id, {
        entity_id: id,
        entity_type: req.entity_type,
        parent_id: req.parent_id,
        name: `${req.name}${tagSuffix(req.idempotency_tag)}`,
        status: 'PAUSED',
        daily_budget_minor: req.daily_budget_minor,
        lifetime_budget_minor: req.lifetime_budget_minor,
        currency: req.currency,
        updated_at: at,
      });
      return id;
    };
    const id = commit();
    if (fault === 'duplicate_commit') commit();
    this.outboundWrites.push({ op: 'create', accountId, at, committed: true });
    if (fault === 'timeout_after_commit') this.throwFor('timeout_after_commit');
    return { remote_id: id, remote_request_id: `mockreq_${this.seq}` };
  }

  async update(accountId: string, req: UpdateRequest): Promise<{ remote_request_id: string }> {
    const fault = this.takeFault('update', req);
    const at = this.now().toISOString();
    if (fault === 'rate_limit' || fault === 'auth_error' || fault === 'validation_error' || fault === 'timeout_before_commit' || fault === 'not_found') {
      this.outboundWrites.push({ op: 'update', accountId, at, committed: false });
      this.throwFor(fault);
    }
    this.checkQuota();
    const e = this.account(accountId).get(req.entity_id);
    if (!e) {
      this.outboundWrites.push({ op: 'update', accountId, at, committed: false });
      throw new AdapterError('not_found', 'Mock: entity not found');
    }
    if (req.set.daily_budget_minor !== undefined) e.daily_budget_minor = req.set.daily_budget_minor;
    if (req.set.lifetime_budget_minor !== undefined) e.lifetime_budget_minor = req.set.lifetime_budget_minor;
    if (req.set.status !== undefined) e.status = req.set.status;
    e.updated_at = at;
    this.outboundWrites.push({ op: 'update', accountId, at, committed: true });
    if (fault === 'timeout_after_commit') this.throwFor('timeout_after_commit');
    return { remote_request_id: `mockreq_${++this.seq}` };
  }

  /** Simulates a change made outside this system (another user in Ads Manager). */
  externalEdit(accountId: string, entityId: string, set: Partial<Pick<RemoteEntity, 'daily_budget_minor' | 'lifetime_budget_minor' | 'status'>>): void {
    const e = this.account(accountId).get(entityId);
    if (!e) throw new Error('no entity');
    Object.assign(e, set, { updated_at: this.now().toISOString() });
  }
}

/** Capability list for mock mode only. These strings are placeholders, not verified Meta enums. */
export const MOCK_CAPABILITIES: CapabilityInfo = {
  snapshot_id: 'cap_mock_fixture_v1',
  verified: true,
  source: 'mock_fixture',
  api_version: 'UNVERIFIED-mock',
  objectives: ['MOCK_OBJECTIVE_SALES'],
  optimization_goals: ['MOCK_OPT_PURCHASE'],
  billing_events: ['MOCK_BILLING_IMPRESSIONS'],
};
