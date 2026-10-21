import { DomainError, canonicalHash, isDomainError, sha256Hex, type Action, type ActionProposal, type ErrorCode, type ExecutionAttempt, type ExecutionReceipt, type ProposalStatus, type RemoteEntity } from '@pod/contracts';
import { AdapterError, type CreateRequest, type MetaWriteAdapter, type UpdateRequest } from '@pod/adapter-meta';
import { evaluatePolicy, remoteFingerprint, reservationAmount } from '@pod/policy';
import { checkApproval } from './approval-service';
import { audit, type Actor, type Deps } from './context';
import { newId } from './ids';
import { buildPolicyContext } from './policy-context';
import { assertCan, type Principal } from './rbac';
import type { JobRecord, Store } from './store/types';

export const idempotencyKey = (tenantId: string, proposalId: string, revision: number, actionId: string): string =>
  sha256Hex(`${tenantId}|${proposalId}|${revision}|${actionId}`);

export const lockScope = (tenantId: string, adAccountId: string): string => `acct:${tenantId}:${adAccountId}`;

const systemActor = (tenantId: string, id = 'system'): Actor => ({ actor_id: id, tenant_id: tenantId, kind: 'system' });

type Fail = { error: DomainError };
const fail = (code: ErrorCode, message: string): Fail => ({ error: new DomainError(code, message) });
const unwrap = <T>(r: T | Fail): T => {
  if (r && typeof r === 'object' && 'error' in r && r.error instanceof DomainError) throw r.error;
  return r as T;
};

export class ExecutionService {
  constructor(private readonly d: Deps) {}

  /**
   * S17 execution.request: takes only (proposal_id, revision, expected hash).
   * Validates server-side, then commits reservation + outbox job + QUEUED
   * status in one transaction. A replayed request returns the existing job.
   */
  async request(p: Principal, proposalId: string, revision: number, expectedPayloadHash: string): Promise<{ job_id: string | null; replay: boolean }> {
    const r = await this.d.store.tx(async (s): Promise<{ job_id: string | null; replay: boolean } | Fail> => {
      const proposal = await s.getProposal(p.tenant_id, proposalId, revision);
      if (!proposal) return fail('INPUT_INVALID', 'Không tìm thấy proposal');
      assertCan(p, 'execution.request', proposal.ad_account_id);
      await s.lockBudgetScope(p.tenant_id, proposal.ad_account_id);
      if (expectedPayloadHash !== proposal.payload_hash) return fail('PAYLOAD_CHANGED', 'Hash không khớp proposal hiện tại');
      if (['QUEUED', 'EXECUTING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'UNKNOWN', 'RECONCILING', 'NEEDS_REVIEW'].includes(proposal.status)) {
        // Replay: the outbox already holds (or held) the job for this revision. Never enqueue twice.
        return { job_id: null, replay: true };
      }
      if (proposal.status !== 'APPROVED') return fail('APPROVAL_REQUIRED', `Proposal đang ${proposal.status}; cần được người có quyền duyệt`);
      if (proposal.mode !== this.d.runtime.mode) return fail('POLICY_BLOCKED', 'Mode của proposal khác mode hệ thống hiện tại');
      if ((await s.getFreeze(p.tenant_id)).frozen) return fail('WRITE_FROZEN', 'Hệ thống đang khóa ghi nội bộ');

      const approval = await checkApproval(this.d, s, proposal);
      if (!approval.ok) {
        if (approval.code === 'APPROVAL_EXPIRED') {
          await s.casProposalStatus(p.tenant_id, proposalId, revision, 'APPROVED', 'EXPIRED');
          await audit(s, this.d.clock, p, proposalId, 'proposal.expired', { revision }, 'Approval hết hạn trước khi xếp hàng');
        }
        return fail(approval.code, approval.message);
      }

      const ctx = await buildPolicyContext(this.d, s, p.tenant_id, proposal.ad_account_id, proposal.actions, proposal.source_snapshot_ids);
      const policy = evaluatePolicy(proposal, ctx);
      if (policy.decision === 'block') {
        await s.putPolicyResult(p.tenant_id, proposalId, revision, policy);
        if (!ctx.frozen) {
          await s.casProposalStatus(p.tenant_id, proposalId, revision, 'APPROVED', 'INVALIDATED');
          await audit(s, this.d.clock, p, proposalId, 'proposal.invalidated', policy, `Revalidation chặn: ${policy.violations.map((v) => v.rule_id).join(', ')}`);
        }
        const first = policy.violations[0]!;
        return fail(first.code, first.message);
      }

      const now = this.d.clock.now().toISOString();
      const res = reservationAmount(proposal.impact);
      await s.insertReservation({
        reservation_id: newId('rsv'),
        tenant_id: p.tenant_id,
        ad_account_id: proposal.ad_account_id,
        proposal_id: proposalId,
        revision,
        daily_minor: res.daily_minor,
        lifetime_minor: res.lifetime_minor,
        currency: proposal.impact.currency,
        status: 'active',
        created_at: now,
        released_at: null,
      });
      const job: JobRecord = {
        job_id: newId('job'),
        tenant_id: p.tenant_id,
        proposal_id: proposalId,
        revision,
        kind: 'execute',
        status: 'pending',
        attempts: 0,
        available_at: now,
        lease_owner: null,
        lease_until: null,
        created_at: now,
        last_error: null,
      };
      await s.insertJob(job);
      if (!(await s.casProposalStatus(p.tenant_id, proposalId, revision, 'APPROVED', 'QUEUED'))) return fail('INPUT_INVALID', 'Trạng thái vừa thay đổi');
      await audit(s, this.d.clock, p, proposalId, 'execution.queued', { job_id: job.job_id, reservation: res }, `Xếp hàng thực thi r${revision}`);
      return { job_id: job.job_id, replay: false };
    });
    return unwrap(r);
  }

  /** Queue a read-only reconciliation for an UNKNOWN proposal (runs in the worker). */
  async requestReconcile(p: Principal, proposalId: string, revision: number): Promise<{ job_id: string }> {
    return this.d.store.tx(async (s) => {
      const proposal = await s.getProposal(p.tenant_id, proposalId, revision);
      if (!proposal) throw new DomainError('INPUT_INVALID', 'Không tìm thấy proposal');
      assertCan(p, 'execution.reconcile', proposal.ad_account_id);
      if (proposal.status !== 'UNKNOWN') throw new DomainError('INPUT_INVALID', `Chỉ reconcile khi UNKNOWN (hiện ${proposal.status})`);
      const now = this.d.clock.now().toISOString();
      const job: JobRecord = { job_id: newId('job'), tenant_id: p.tenant_id, proposal_id: proposalId, revision, kind: 'reconcile', status: 'pending', attempts: 0, available_at: now, lease_owner: null, lease_until: null, created_at: now, last_error: null };
      await s.insertJob(job);
      await audit(s, this.d.clock, p, proposalId, 'execution.reconcile_requested', { job_id: job.job_id }, 'Yêu cầu đối soát');
      return { job_id: job.job_id };
    });
  }
}

type ActionOutcome = { status: ExecutionAttempt['status']; remote_id: string | null; error_code: ErrorCode | null; readback_verified: boolean };

export type WorkerOptions = { workerId: string; leaseMs?: number; lockTtlMs?: number; frozenRetryMs?: number };

/**
 * The only component holding a Meta write adapter. Revalidates everything
 * under an account lock with fencing, writes the idempotency ledger before
 * each call, never blind-retries a create, and reconciles UNKNOWN outcomes.
 */
export class ExecutionWorker {
  private readonly write: MetaWriteAdapter;
  private readonly leaseMs: number;
  private readonly lockTtlMs: number;
  private readonly frozenRetryMs: number;
  /** Test hook: runs after each action, e.g. to simulate a kill switch or lock loss mid-batch. */
  afterAction: ((actionId: string) => Promise<void>) | null = null;

  constructor(
    private readonly d: Deps,
    private readonly opts: WorkerOptions,
  ) {
    if (!d.metaWrite) throw new Error('ExecutionWorker cần Meta write adapter');
    this.write = d.metaWrite;
    this.leaseMs = opts.leaseMs ?? 120_000;
    this.lockTtlMs = opts.lockTtlMs ?? 60_000;
    this.frozenRetryMs = opts.frozenRetryMs ?? 30_000;
  }

  private now(): string {
    return this.d.clock.now().toISOString();
  }

  /** Process at most one job. */
  async runOnce(): Promise<'idle' | 'processed'> {
    const job = await this.d.store.leaseNextJob(this.now(), this.leaseMs, this.opts.workerId);
    if (!job) return 'idle';
    try {
      await this.handle(job);
    } catch (e) {
      // Fail closed: the job is released for a later attempt; nothing was sent unless the ledger says so.
      const msg = isDomainError(e) ? `${e.code}: ${e.message}` : 'internal_error';
      await this.d.store.releaseJob(job.job_id, this.opts.workerId, new Date(Date.parse(this.now()) + 10_000).toISOString(), msg);
    }
    return 'processed';
  }

  async drain(max = 100): Promise<number> {
    let n = 0;
    while (n < max && (await this.runOnce()) === 'processed') n++;
    return n;
  }

  private modeAllowed(p: ActionProposal): string | null {
    const rt = this.d.runtime;
    if (p.mode === 'mock') return this.write.kind === 'mock' ? null : 'Proposal mock không được chạy trên adapter thật';
    if (p.mode === 'read_only') return 'read_only không có quyền ghi';
    if (!rt.liveWritesEnabled) return 'LIVE_WRITES_ENABLED=false';
    if (!rt.accountAllowlist.includes(p.ad_account_id)) return 'Ad account ngoài allowlist';
    if (this.write.kind !== 'live') return 'Proposal approval cần adapter live';
    return null;
  }

  private async handle(job: JobRecord): Promise<void> {
    const { store } = this.d;
    const t = job.tenant_id;
    const proposal = await store.getProposal(t, job.proposal_id, job.revision);
    const actor = systemActor(t, `worker:${this.opts.workerId}`);
    if (job.kind === 'reconcile') {
      // Reconciliation is read-only against the remote, so it runs even while writes are frozen.
      if (proposal?.status === 'UNKNOWN') await this.reconcile(actor, t, job.proposal_id, job.revision);
      await store.completeJob(job.job_id, this.opts.workerId, 'done', null);
      return;
    }
    if (!proposal || !['QUEUED', 'EXECUTING'].includes(proposal.status)) {
      await store.completeJob(job.job_id, this.opts.workerId, 'done', proposal ? `skip:${proposal.status}` : 'skip:missing');
      return;
    }

    // Kill switch applies to jobs already in the queue.
    if ((await store.getFreeze(t)).frozen) {
      await store.tx(async (s) => {
        await audit(s, this.d.clock, actor, proposal.proposal_id, 'execution.blocked_frozen', { job: job.job_id }, 'Kill switch: job bị giữ lại, không gửi mutation');
        await s.releaseJob(job.job_id, this.opts.workerId, new Date(Date.parse(this.now()) + this.frozenRetryMs).toISOString(), 'WRITE_FROZEN');
      });
      return;
    }

    const modeProblem = this.modeAllowed(proposal);
    if (modeProblem) {
      await store.tx(async (s) => {
        if (proposal.status === 'QUEUED') await s.casProposalStatus(t, proposal.proposal_id, proposal.revision, 'QUEUED', 'INVALIDATED');
        await s.releaseReservations(t, proposal.proposal_id, proposal.revision, this.now());
        await audit(s, this.d.clock, actor, proposal.proposal_id, 'execution.mode_rejected', { reason: modeProblem }, modeProblem);
        await s.completeJob(job.job_id, this.opts.workerId, 'dead', modeProblem);
      });
      return;
    }

    const approval = await checkApproval(this.d, store, proposal);
    if (!approval.ok && proposal.status === 'QUEUED') {
      const to: ProposalStatus = approval.code === 'APPROVAL_EXPIRED' ? 'EXPIRED' : 'INVALIDATED';
      await store.tx(async (s) => {
        await s.casProposalStatus(t, proposal.proposal_id, proposal.revision, 'QUEUED', to);
        await s.releaseReservations(t, proposal.proposal_id, proposal.revision, this.now());
        await audit(s, this.d.clock, actor, proposal.proposal_id, `proposal.${to.toLowerCase()}`, { code: approval.code }, approval.message);
        await s.completeJob(job.job_id, this.opts.workerId, 'done', approval.code);
      });
      return;
    }

    const scope = lockScope(t, proposal.ad_account_id);
    const lock = await store.acquireLock(scope, this.opts.workerId, this.now(), this.lockTtlMs);
    if (!lock) {
      await store.releaseJob(job.job_id, this.opts.workerId, new Date(Date.parse(this.now()) + 5_000).toISOString(), 'lock_busy');
      return;
    }
    try {
      if (proposal.status === 'QUEUED') {
        const ctx = await buildPolicyContext(this.d, store, t, proposal.ad_account_id, proposal.actions, proposal.source_snapshot_ids, {
          proposal_id: proposal.proposal_id,
          revision: proposal.revision,
        });
        const policy = evaluatePolicy(proposal, ctx);
        if (policy.decision === 'block') {
          await store.tx(async (s) => {
            await s.putPolicyResult(t, proposal.proposal_id, proposal.revision, policy);
            await s.casProposalStatus(t, proposal.proposal_id, proposal.revision, 'QUEUED', 'INVALIDATED');
            await s.releaseReservations(t, proposal.proposal_id, proposal.revision, this.now());
            await audit(s, this.d.clock, actor, proposal.proposal_id, 'proposal.invalidated', policy, `Worker revalidation chặn: ${policy.violations.map((v) => v.rule_id).join(', ')}`);
            await s.completeJob(job.job_id, this.opts.workerId, 'done', 'INVALIDATED');
          });
          return;
        }
        await store.tx(async (s) => {
          if (!(await s.casProposalStatus(t, proposal.proposal_id, proposal.revision, 'QUEUED', 'EXECUTING'))) throw new DomainError('INPUT_INVALID', 'Trạng thái vừa thay đổi');
          await audit(s, this.d.clock, actor, proposal.proposal_id, 'execution.started', { fencing_token: lock.token }, 'Bắt đầu thực thi');
        });
        proposal.status = 'EXECUTING';
      }

      const outcomes = await this.runActions(proposal, actor, scope, lock.token);
      const final = finalStatus(outcomes);
      await store.tx(async (s) => {
        if (!(await s.casProposalStatus(t, proposal.proposal_id, proposal.revision, 'EXECUTING', final))) throw new DomainError('INPUT_INVALID', 'Trạng thái vừa thay đổi');
        if (final !== 'UNKNOWN') await s.releaseReservations(t, proposal.proposal_id, proposal.revision, this.now());
        const receipt = await this.buildReceipt(s, proposal, final, approval.ok ? approval.approval.approval_id : 'approval_invalid_mid_batch');
        await s.putReceipt(receipt);
        await audit(s, this.d.clock, actor, proposal.proposal_id, 'execution.finished', receipt, `Kết thúc: ${final}`);
        await s.completeJob(job.job_id, this.opts.workerId, 'done', null);
      });
      if (final === 'UNKNOWN') await this.reconcile(actor, t, proposal.proposal_id, proposal.revision);
    } finally {
      await store.releaseLock(scope, this.opts.workerId, lock.token);
    }
  }

  /** Guards re-checked immediately before each outbound mutation. */
  private async preMutationBlock(proposal: ActionProposal, scope: string, token: number): Promise<{ code: ErrorCode; message: string } | null> {
    const { store } = this.d;
    if ((await store.getFreeze(proposal.tenant_id)).frozen) return { code: 'WRITE_FROZEN', message: 'Kill switch bật giữa batch' };
    const approval = await checkApproval(this.d, store, proposal);
    if (!approval.ok) return { code: approval.code, message: approval.message };
    if (!(await store.isFenceValid(scope, token, this.now()))) return { code: 'REMOTE_UNKNOWN', message: 'Mất khóa account (fencing)' };
    return null;
  }

  private async runActions(proposal: ActionProposal, actor: Actor, scope: string, token: number): Promise<Map<string, ActionOutcome>> {
    const { store } = this.d;
    const t = proposal.tenant_id;
    const outcomes = new Map<string, ActionOutcome>();
    let stop: { code: ErrorCode; message: string } | null = null;

    for (const action of proposal.actions) {
      const key = idempotencyKey(t, proposal.proposal_id, proposal.revision, action.action_id);
      const existing = await store.getAttemptByKey(t, key);
      if (existing) {
        // Redelivery / resume: never resend. Pending or unknown means outcome is not known → reconcile.
        const status = existing.status === 'pending' ? 'unknown' : existing.status;
        outcomes.set(action.action_id, { status, remote_id: existing.remote_id, error_code: existing.sanitized_error?.code ?? null, readback_verified: status === 'succeeded' });
        if (status !== 'succeeded') stop ??= { code: 'REMOTE_UNKNOWN', message: 'Attempt trước chưa rõ kết quả' };
        continue;
      }
      const depsOk = action.depends_on.every((dep) => outcomes.get(dep)?.status === 'succeeded');
      if (!stop && !depsOk) stop = { code: 'INPUT_INVALID', message: 'Dependency chưa thành công' };
      if (!stop) stop = await this.preMutationBlock(proposal, scope, token);
      if (stop) {
        await this.recordSkipped(proposal, action, key, token, stop);
        outcomes.set(action.action_id, { status: 'skipped', remote_id: null, error_code: stop.code, readback_verified: false });
        continue;
      }
      const outcome = await this.executeAction(proposal, action, key, scope, token, actor);
      outcomes.set(action.action_id, outcome);
      if (outcome.status !== 'succeeded') stop = { code: outcome.error_code ?? 'REMOTE_UNKNOWN', message: 'Action trước thất bại hoặc chưa rõ; dừng phần còn lại' };
      if (this.afterAction) await this.afterAction(action.action_id);
    }
    return outcomes;
  }

  private async recordSkipped(proposal: ActionProposal, action: Action, key: string, token: number, why: { code: ErrorCode; message: string }): Promise<void> {
    const now = this.now();
    await this.d.store.tx(async (s) => {
      // Skipped rows are written without a fence: they record that nothing was sent.
      const a: ExecutionAttempt = {
        attempt_id: newId('att'),
        tenant_id: proposal.tenant_id,
        proposal_id: proposal.proposal_id,
        revision: proposal.revision,
        action_id: action.action_id,
        idempotency_key: key,
        request_hash: canonicalHash({ skipped: action.action_id }),
        remote_request_id: null,
        remote_id: null,
        before_snapshot_ref: null,
        after_snapshot_ref: null,
        started_at: now,
        finished_at: now,
        sanitized_error: { code: why.code, message: why.message.slice(0, 500) },
        status: 'skipped',
        fencing_token: token,
      };
      if (!(await s.getAttemptByKey(proposal.tenant_id, key))) await s.insertAttempt(a, null);
      await audit(s, this.d.clock, systemActor(proposal.tenant_id), proposal.proposal_id, 'execution.action_skipped', { action_id: action.action_id, code: why.code }, `Bỏ qua ${action.action_id}: ${why.code}`);
    });
  }

  private async buildRequest(
    proposal: ActionProposal,
    action: Action,
    tag: string,
  ): Promise<{ create?: CreateRequest; update?: UpdateRequest; before: RemoteEntity | null } | { error: { code: ErrorCode; message: string } }> {
    const t = proposal.tenant_id;
    const refs = await this.d.store.getLocalRefs(t, proposal.proposal_id, proposal.revision);
    const resolveParent = (parent: { local_ref: string } | { entity_id: string }): string | null => ('local_ref' in parent ? (refs[parent.local_ref] ?? null) : parent.entity_id);
    const currency = proposal.impact.currency;
    switch (action.kind) {
      case 'CREATE_CAMPAIGN_PAUSED':
        return {
          before: null,
          create: { entity_type: 'campaign', parent_id: null, name: action.params.name, daily_budget_minor: action.params.daily_budget?.amount_minor ?? null, lifetime_budget_minor: null, currency, idempotency_tag: tag, extra: { objective: action.params.objective } },
        };
      case 'CREATE_ADSET_PAUSED': {
        const parent = resolveParent(action.parent);
        if (!parent) return { error: { code: 'INPUT_INVALID', message: 'Không resolve được campaign cha' } };
        const p = action.params;
        return {
          before: null,
          create: {
            entity_type: 'adset',
            parent_id: parent,
            name: p.name,
            daily_budget_minor: p.daily_budget?.amount_minor ?? null,
            lifetime_budget_minor: p.lifetime_budget?.amount_minor ?? null,
            currency,
            idempotency_tag: tag,
            extra: { optimization_goal: p.optimization_goal, billing_event: p.billing_event, audience_ref: p.audience_ref, start_time: p.start_time, end_time: p.end_time, schedule_timezone: p.schedule_timezone },
          },
        };
      }
      case 'CREATE_AD_PAUSED': {
        const parent = resolveParent(action.parent);
        if (!parent) return { error: { code: 'INPUT_INVALID', message: 'Không resolve được ad set cha' } };
        const p = action.params;
        return {
          before: null,
          create: { entity_type: 'ad', parent_id: parent, name: p.name, daily_budget_minor: null, lifetime_budget_minor: null, currency, idempotency_tag: tag, extra: { creative_asset_id: p.creative_asset_id, creative_sha256: p.creative_sha256, copy_variant_id: p.copy_variant_id } },
        };
      }
      default: {
        const before = await this.write.getEntity(proposal.ad_account_id, action.entity_id);
        if (!before || remoteFingerprint(before) !== action.preconditions.remote_fingerprint) {
          return { error: { code: 'REMOTE_DRIFT', message: 'Remote before-state đã thay đổi so với lúc duyệt' } };
        }
        const set: UpdateRequest['set'] =
          action.kind === 'SET_DAILY_BUDGET'
            ? { daily_budget_minor: action.after.amount_minor }
            : action.kind === 'SET_LIFETIME_BUDGET'
              ? { lifetime_budget_minor: action.after.amount_minor }
              : { status: action.after.status };
        return { before, update: { entity_id: action.entity_id, set } };
      }
    }
  }

  private async executeAction(proposal: ActionProposal, action: Action, key: string, scope: string, token: number, actor: Actor): Promise<ActionOutcome> {
    const { store } = this.d;
    const t = proposal.tenant_id;
    const tag = key.slice(0, 16);
    let built: Awaited<ReturnType<ExecutionWorker['buildRequest']>>;
    try {
      built = await this.buildRequest(proposal, action, tag);
    } catch (e) {
      built = { error: { code: e instanceof AdapterError && e.kind === 'rate_limited' ? 'RATE_LIMITED' : 'REMOTE_DRIFT', message: 'Không đọc được remote before-state' } };
    }

    const startedAt = this.now();
    const attempt: ExecutionAttempt = {
      attempt_id: newId('att'),
      tenant_id: t,
      proposal_id: proposal.proposal_id,
      revision: proposal.revision,
      action_id: action.action_id,
      idempotency_key: key,
      request_hash: canonicalHash('error' in built ? { error: built.error.code } : (built.create ?? built.update)),
      remote_request_id: null,
      remote_id: null,
      before_snapshot_ref: null,
      after_snapshot_ref: null,
      started_at: startedAt,
      finished_at: null,
      sanitized_error: null,
      status: 'pending',
      fencing_token: token,
    };

    if ('error' in built) {
      const failed = { ...attempt, status: 'failed' as const, finished_at: startedAt, sanitized_error: { code: built.error.code, message: built.error.message } };
      await store.tx(async (s) => {
        await s.insertAttempt(failed, { scope, now: startedAt });
        await audit(s, this.d.clock, actor, proposal.proposal_id, 'execution.action_failed', { action_id: action.action_id, code: built.error.code }, built.error.message);
      });
      return { status: 'failed', remote_id: null, error_code: built.error.code, readback_verified: false };
    }

    // Pre-create probe: if an entity with this idempotency tag already exists (e.g. after a DB restore), adopt it instead of creating a duplicate.
    if (built.create) {
      const found = await this.write.findByIdempotencyTag(proposal.ad_account_id, tag);
      if (found.length > 0) {
        const status = found.length === 1 ? 'succeeded' : 'unknown';
        const adopted = { ...attempt, status, remote_id: found.length === 1 ? found[0]!.entity_id : null, finished_at: startedAt } as ExecutionAttempt;
        await store.tx(async (s) => {
          await s.insertAttempt(adopted, { scope, now: startedAt });
          if (status === 'succeeded' && 'local_ref' in action) await s.putLocalRef(t, proposal.proposal_id, proposal.revision, action.local_ref, adopted.remote_id!);
          await audit(s, this.d.clock, actor, proposal.proposal_id, 'execution.create_adopted', { action_id: action.action_id, found: found.length }, 'Đối tượng với idempotency tag đã tồn tại; không tạo lại');
        });
        return { status, remote_id: adopted.remote_id, error_code: status === 'unknown' ? 'REMOTE_UNKNOWN' : null, readback_verified: status === 'succeeded' };
      }
    }

    // Ledger row + audit committed BEFORE the outbound call. If audit storage is down this throws and nothing is sent.
    await store.tx(async (s) => {
      await s.insertAttempt(attempt, { scope, now: startedAt });
      await audit(s, this.d.clock, actor, proposal.proposal_id, 'execution.attempt_started', { action_id: action.action_id, request_hash: attempt.request_hash }, `Gửi ${action.kind}`);
    });

    let remoteId: string | null = null;
    let remoteRequestId: string | null = null;
    try {
      if (built.create) {
        const r = await this.write.create(proposal.ad_account_id, built.create);
        remoteId = r.remote_id;
        remoteRequestId = r.remote_request_id;
      } else if (built.update) {
        const r = await this.write.update(proposal.ad_account_id, built.update);
        remoteId = built.update.entity_id;
        remoteRequestId = r.remote_request_id;
      }
    } catch (e) {
      const unknown = !(e instanceof AdapterError) || e.kind === 'timeout' || e.kind === 'network';
      const code: ErrorCode = unknown ? 'REMOTE_UNKNOWN' : e.kind === 'rate_limited' ? 'RATE_LIMITED' : e.kind === 'auth' ? 'PERMISSION_DENIED' : e.kind === 'unsupported' ? 'CAPABILITY_UNSUPPORTED' : 'INPUT_INVALID';
      const done: ExecutionAttempt = {
        ...attempt,
        status: unknown ? 'unknown' : 'failed',
        finished_at: this.now(),
        sanitized_error: { code, message: e instanceof AdapterError ? e.message.slice(0, 200) : 'Lỗi không xác định khi gọi adapter' },
      };
      await store.tx(async (s) => {
        await s.updateAttempt(done, null);
        await audit(s, this.d.clock, actor, proposal.proposal_id, unknown ? 'execution.action_unknown' : 'execution.action_failed', { action_id: action.action_id, code }, `${action.action_id}: ${code}`);
        if (code === 'PERMISSION_DENIED') {
          await s.insertIncident({
            incident_id: newId('inc'),
            tenant_id: t,
            severity: 'sev2',
            affected_scope: { ad_account_ids: [proposal.ad_account_id], components: ['meta_adapter'] },
            detected_at: this.now(),
            state: 'open',
            evidence: [{ kind: 'execution_attempt', ref: attempt.attempt_id, note: 'Adapter trả lỗi quyền/token' }],
            containment: { writes_frozen: false, note: 'Chưa tự khóa ghi; operator quyết định' },
            recovery_owner: null,
            resolution: null,
          });
        }
      });
      return { status: done.status, remote_id: null, error_code: code, readback_verified: false };
    }

    // Provider-side duplicate with a normal response: more than one entity carries our tag.
    if (built.create) {
      const tagged = await this.write.findByIdempotencyTag(proposal.ad_account_id, tag).catch(() => []);
      if (tagged.length > 1) {
        await store.tx(async (s) => {
          await s.updateAttempt({ ...attempt, status: 'unknown', remote_id: remoteId, remote_request_id: remoteRequestId, finished_at: this.now(), sanitized_error: { code: 'REMOTE_UNKNOWN', message: `Phát hiện ${tagged.length} đối tượng cùng idempotency tag` } }, null);
          await audit(s, this.d.clock, actor, proposal.proposal_id, 'execution.duplicate_detected', { action_id: action.action_id, count: tagged.length }, 'Remote có bản trùng; cần người xử lý');
        });
        return { status: 'unknown', remote_id: remoteId, error_code: 'REMOTE_UNKNOWN', readback_verified: false };
      }
    }

    // Remote readback: confirm the change landed as requested.
    let verified = false;
    try {
      const after = remoteId ? await this.write.getEntity(proposal.ad_account_id, remoteId) : null;
      verified = !!after && readbackMatches(after, built.create ?? null, built.update ?? null);
    } catch {
      verified = false;
    }
    const finishedAt = this.now();
    await store.tx(async (s) => {
      await s.updateAttempt({ ...attempt, status: 'succeeded', remote_id: remoteId, remote_request_id: remoteRequestId, finished_at: finishedAt }, null);
      if ('local_ref' in action && remoteId) await s.putLocalRef(t, proposal.proposal_id, proposal.revision, action.local_ref, remoteId);
      if (remoteId) {
        await s.recordEntityChange({ tenant_id: t, ad_account_id: proposal.ad_account_id, entity_id: remoteId, changed_at: finishedAt, proposal_id: proposal.proposal_id });
        if (verified && built.create) await s.addVerifiedEntity({ tenant_id: t, ad_account_id: proposal.ad_account_id, entity_id: remoteId, proposal_id: proposal.proposal_id, verified_at: finishedAt });
      }
      await audit(s, this.d.clock, actor, proposal.proposal_id, 'execution.action_succeeded', { action_id: action.action_id, remote_id: remoteId, verified }, `${action.action_id} OK${verified ? ' (readback khớp)' : ' (readback chưa khớp)'}`);
    });
    return { status: 'succeeded', remote_id: remoteId, error_code: null, readback_verified: verified };
  }

  /**
   * UNKNOWN → RECONCILING → SUCCEEDED | PARTIAL | FAILED | NEEDS_REVIEW.
   * Read-only against the remote. Never re-sends a create. If an outcome
   * cannot be proven, the proposal lands in NEEDS_REVIEW.
   */
  async reconcile(actor: Actor, tenantId: string, proposalId: string, revision: number): Promise<ExecutionReceipt> {
    const { store } = this.d;
    const proposal = await store.getProposal(tenantId, proposalId, revision);
    if (!proposal) throw new DomainError('INPUT_INVALID', 'Không tìm thấy proposal');
    if (proposal.status !== 'UNKNOWN') {
      const r = await store.getReceipt(tenantId, proposalId, revision);
      if (r) return r;
      throw new DomainError('INPUT_INVALID', `Proposal đang ${proposal.status}; chỉ reconcile khi UNKNOWN`);
    }
    await store.tx(async (s) => {
      if (!(await s.casProposalStatus(tenantId, proposalId, revision, 'UNKNOWN', 'RECONCILING'))) throw new DomainError('INPUT_INVALID', 'Trạng thái vừa thay đổi');
      await audit(s, this.d.clock, actor, proposalId, 'execution.reconciling', { revision }, 'Bắt đầu đối soát remote');
    });

    const attempts = await store.listAttempts(tenantId, proposalId, revision);
    let unresolved = 0;
    for (const att of attempts) {
      if (att.status !== 'unknown' && att.status !== 'pending') continue;
      const action = proposal.actions.find((a) => a.action_id === att.action_id);
      if (!action) continue;
      let resolved: ExecutionAttempt | null = null;
      let note = '';
      try {
      if (action.kind.startsWith('CREATE_')) {
        const found = await this.write.findByIdempotencyTag(proposal.ad_account_id, att.idempotency_key.slice(0, 16));
        if (found.length === 1) {
          resolved = { ...att, status: 'succeeded', remote_id: found[0]!.entity_id, finished_at: this.now() };
          note = 'Tìm thấy đúng 1 đối tượng theo idempotency tag';
        } else {
          note = found.length === 0 ? 'Không tìm thấy trên remote: không chứng minh được, không tạo lại' : `Tìm thấy ${found.length} bản trùng: cần người xử lý`;
        }
      } else if (action.kind === 'SET_DAILY_BUDGET' || action.kind === 'SET_LIFETIME_BUDGET' || action.kind === 'SET_STATUS') {
        const e = await this.write.getEntity(proposal.ad_account_id, action.entity_id);
        const value = (x: RemoteEntity) => (action.kind === 'SET_DAILY_BUDGET' ? x.daily_budget_minor : action.kind === 'SET_LIFETIME_BUDGET' ? x.lifetime_budget_minor : x.status);
        const afterV = action.kind === 'SET_STATUS' ? action.after.status : action.after.amount_minor;
        const beforeV = action.kind === 'SET_STATUS' ? action.before.status : action.before.amount_minor;
        if (e && value(e) === afterV) {
          resolved = { ...att, status: 'succeeded', remote_id: e.entity_id, finished_at: this.now() };
          note = 'Remote đã có giá trị after';
        } else if (e && value(e) === beforeV && remoteFingerprint(e) === action.preconditions.remote_fingerprint) {
          resolved = { ...att, status: 'failed', finished_at: this.now(), sanitized_error: { code: 'REMOTE_UNKNOWN', message: 'Remote vẫn ở before-state: mutation không được áp dụng' } };
          note = 'Remote vẫn ở before-state';
        } else {
          note = 'Remote khác cả before và after: cần người xử lý';
        }
      }
      } catch {
        // Unreadable remote is not proof of anything: leave unresolved (→ NEEDS_REVIEW), never retry the mutation.
        resolved = null;
        note = 'Không đọc được remote khi đối soát';
      }
      await store.tx(async (s) => {
        if (resolved) {
          await s.updateAttempt(resolved, null);
          if (resolved.status === 'succeeded' && 'local_ref' in action && resolved.remote_id) {
            await s.putLocalRef(tenantId, proposalId, revision, action.local_ref, resolved.remote_id);
            await s.addVerifiedEntity({ tenant_id: tenantId, ad_account_id: proposal.ad_account_id, entity_id: resolved.remote_id, proposal_id: proposalId, verified_at: this.now() });
          }
          if (resolved.status === 'succeeded' && resolved.remote_id) {
            await s.recordEntityChange({ tenant_id: tenantId, ad_account_id: proposal.ad_account_id, entity_id: resolved.remote_id, changed_at: this.now(), proposal_id: proposalId });
          }
        }
        await audit(s, this.d.clock, actor, proposalId, 'execution.reconciled_action', { action_id: att.action_id, resolved: resolved?.status ?? 'unresolved' }, note);
      });
      if (!resolved) unresolved++;
    }

    const latest = await store.listAttempts(tenantId, proposalId, revision);
    const outcomes = new Map<string, ActionOutcome>(latest.map((a) => [a.action_id, { status: a.status, remote_id: a.remote_id, error_code: a.sanitized_error?.code ?? null, readback_verified: a.status === 'succeeded' }]));
    const final: ProposalStatus = unresolved > 0 ? 'NEEDS_REVIEW' : finalStatus(outcomes, true);
    return store.tx(async (s) => {
      if (!(await s.casProposalStatus(tenantId, proposalId, revision, 'RECONCILING', final))) throw new DomainError('INPUT_INVALID', 'Trạng thái vừa thay đổi');
      if (final !== 'NEEDS_REVIEW') await s.releaseReservations(tenantId, proposalId, revision, this.now());
      const approvals = await s.listApprovals(tenantId, proposalId, revision);
      const receipt = await this.buildReceipt(s, proposal, final, approvals.find((a) => a.decision === 'approved')?.approval_id ?? 'none');
      await s.putReceipt(receipt);
      await audit(s, this.d.clock, actor, proposalId, 'execution.reconcile_finished', receipt, `Đối soát xong: ${final}`);
      return receipt;
    });
  }

  private async buildReceipt(s: Store, proposal: ActionProposal, final: ProposalStatus, approvalId: string): Promise<ExecutionReceipt> {
    const attempts = await s.listAttempts(proposal.tenant_id, proposal.proposal_id, proposal.revision);
    const refs = await s.getLocalRefs(proposal.tenant_id, proposal.proposal_id, proposal.revision);
    const verified = await s.listVerifiedEntities(proposal.tenant_id, proposal.ad_account_id);
    const recovery: string[] = [];
    if (final === 'PARTIAL') recovery.push('Các action sau lỗi đã bị bỏ qua; đối tượng đã tạo vẫn ở PAUSED. Lập revision mới để tiếp tục hoặc khắc phục.');
    if (final === 'FAILED') recovery.push('Không có thay đổi nào được xác nhận trên remote. Xem mã lỗi từng action.');
    if (final === 'UNKNOWN' || final === 'NEEDS_REVIEW') {
      recovery.push('Kiểm tra trong Ads Manager các đối tượng có hậu tố [pam:<tag>] hoặc giá trị budget/status hiện tại; KHÔNG tạo lại tự động.');
      recovery.push('Reservation ngân sách được giữ cho đến khi người xử lý xác nhận.');
    }
    if (final !== 'SUCCEEDED') recovery.push('Rollback (nếu cần) là proposal riêng, cần revalidation và duyệt; không hoàn lại tiền đã tiêu hay khôi phục learning.');
    return {
      receipt_id: `rcp_${proposal.proposal_id}_r${proposal.revision}`,
      tenant_id: proposal.tenant_id,
      proposal_id: proposal.proposal_id,
      revision: proposal.revision,
      payload_hash: proposal.payload_hash,
      approval_id: approvalId,
      mode: proposal.mode,
      final_status: final,
      actions: proposal.actions.map((a) => {
        const att = attempts.find((x) => x.action_id === a.action_id);
        const localRef = 'local_ref' in a ? a.local_ref : null;
        const remoteId = att?.remote_id ?? null;
        return {
          action_id: a.action_id,
          kind: a.kind,
          status: att?.status ?? 'skipped',
          remote_id: remoteId,
          local_ref: localRef,
          error_code: att?.sanitized_error?.code ?? null,
          readback_verified: att?.status === 'succeeded' && (a.kind.startsWith('CREATE_') ? !!remoteId && verified.has(remoteId) : true),
        };
      }),
      local_ref_map: refs,
      recovery_plan: recovery,
      completed_at: this.now(),
      simulated: proposal.mode === 'mock',
    };
  }
}

function readbackMatches(e: RemoteEntity, create: CreateRequest | null, update: UpdateRequest | null): boolean {
  if (create) return e.status === 'PAUSED' && e.daily_budget_minor === create.daily_budget_minor && e.lifetime_budget_minor === create.lifetime_budget_minor && e.entity_type === create.entity_type;
  if (update) {
    const s = update.set;
    return (s.daily_budget_minor === undefined || e.daily_budget_minor === s.daily_budget_minor) && (s.lifetime_budget_minor === undefined || e.lifetime_budget_minor === s.lifetime_budget_minor) && (s.status === undefined || e.status === s.status);
  }
  return false;
}

export function finalStatus(outcomes: ReadonlyMap<string, ActionOutcome>, afterReconcile = false): ProposalStatus {
  const list = [...outcomes.values()];
  if (!afterReconcile && list.some((o) => o.status === 'unknown' || o.status === 'pending')) return 'UNKNOWN';
  const ok = list.filter((o) => o.status === 'succeeded').length;
  if (ok === list.length && list.length > 0) return 'SUCCEEDED';
  if (ok > 0) return 'PARTIAL';
  return 'FAILED';
}
