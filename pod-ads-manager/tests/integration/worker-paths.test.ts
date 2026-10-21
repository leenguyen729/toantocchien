import { describe, expect, it } from 'vitest';
import type { ActionProposal, Mode, RemoteEntity } from '@pod/contracts';
import { AdapterError, UnverifiedLiveMetaAdapter, tagSuffix } from '@pod/adapter-meta';
import { remoteFingerprint } from '@pod/policy';
import { ExecutionWorker, idempotencyKey, type MemoryStore } from '@pod/domain';
import { createHierarchy, makeSystem, proposeAndApprove, proposeInput, remote, setDailyBudget, setStatus } from '../helpers';

type Ctx = Awaited<ReturnType<typeof makeSystem>>;

/** Test-only: reach into the memory store to simulate states that only crashes or bugs produce. */
function rawProposals(store: MemoryStore): ActionProposal[] {
  return (store as unknown as { ops: { d: { proposals: ActionProposal[] } } }).ops.d.proposals;
}

async function queued(ctx: Ctx, actions: Parameters<typeof proposeAndApprove>[1]) {
  const p = await proposeAndApprove(ctx, actions);
  await ctx.sys.execution.request(ctx.people.u_analyst!, p.proposal_id, 1, p.payload_hash);
  return p;
}
const status = async (ctx: Ctx, p: ActionProposal) => (await ctx.store.getProposal(p.tenant_id, p.proposal_id, p.revision))!.status;

describe('worker: mode gates (defence in depth behind policy)', () => {
  const cases: { name: string; mode: Mode; runtime?: Partial<Ctx['sys']['deps']['runtime']>; live?: boolean; reason: RegExp }[] = [
    { name: 'read_only proposal', mode: 'read_only', reason: /read_only/ },
    { name: 'approval without live flag', mode: 'approval', reason: /LIVE_WRITES_ENABLED/ },
    { name: 'approval outside allowlist', mode: 'approval', runtime: { liveWritesEnabled: true }, reason: /allowlist/ },
    { name: 'approval on mock adapter', mode: 'approval', runtime: { liveWritesEnabled: true, accountAllowlist: ['act_demo'] }, reason: /adapter live/ },
    { name: 'mock proposal on live adapter', mode: 'mock', live: true, reason: /adapter thật/ },
  ];
  for (const c of cases) {
    it(`${c.name} → INVALIDATED, job dead, zero writes`, async () => {
      const ctx = await makeSystem();
      const p = await queued(ctx, [await setDailyBudget(ctx.sys, 'adset_demo', 1100)]);
      rawProposals(ctx.store).find((x) => x.proposal_id === p.proposal_id)!.mode = c.mode;
      const deps = { ...ctx.sys.deps, runtime: { ...ctx.sys.deps.runtime, ...c.runtime }, metaWrite: c.live ? new UnverifiedLiveMetaAdapter() : ctx.meta };
      await new ExecutionWorker(deps, { workerId: 'wm' }).drain();
      expect(await status(ctx, p)).toBe('INVALIDATED');
      const audit = await ctx.store.listAudit(p.tenant_id, { correlation_id: p.proposal_id });
      expect(audit.find((e) => e.event_type === 'execution.mode_rejected')?.summary).toMatch(c.reason);
      expect(ctx.meta.outboundWrites).toHaveLength(0);
    });
  }

  it('execution.request refuses a proposal whose mode differs from the system mode', async () => {
    const ctx = await makeSystem();
    const p = await proposeAndApprove(ctx, [await setDailyBudget(ctx.sys, 'adset_demo', 1100)]);
    rawProposals(ctx.store).find((x) => x.proposal_id === p.proposal_id)!.mode = 'approval';
    await expect(ctx.sys.execution.request(ctx.people.u_analyst!, p.proposal_id, 1, p.payload_hash)).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
  });

  it('a worker cannot be built without a write adapter', async () => {
    const ctx = await makeSystem();
    expect(() => new ExecutionWorker({ ...ctx.sys.deps, metaWrite: null }, { workerId: 'x' })).toThrow();
  });
});

describe('worker: crash and resume', () => {
  it('crash after the first action: resume does not resend it', async () => {
    const ctx = await makeSystem();
    const p = await queued(ctx, [await setDailyBudget(ctx.sys, 'adset_demo', 1100, 'a1'), await setDailyBudget(ctx.sys, 'adset_demo_2', 1600, 'a2')]);
    const w = new ExecutionWorker(ctx.sys.deps, { workerId: 'w1', leaseMs: 1000, lockTtlMs: 1000 });
    w.afterAction = async () => {
      throw new Error('worker process killed');
    };
    await w.runOnce();
    expect(await status(ctx, p)).toBe('EXECUTING');
    ctx.clock.advance(15_000);
    await ctx.worker.drain();
    expect(await status(ctx, p)).toBe('SUCCEEDED');
    expect(ctx.meta.outboundWrites.filter((x) => x.committed)).toHaveLength(2);
    expect((await remote(ctx.sys, 'adset_demo_2')).daily_budget_minor).toBe(1600);
  });

  it('crash between ledger write and outcome: pending row → UNKNOWN → reconciled, never re-sent', async () => {
    const ctx = await makeSystem();
    const p = await queued(ctx, [await setDailyBudget(ctx.sys, 'adset_demo', 1100)]);
    const real = ctx.store.updateAttempt.bind(ctx.store);
    let failOnce = true;
    ctx.store.updateAttempt = async (a, f) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('db connection lost');
      }
      return real(a, f);
    };
    // The worker either reconciles inline or after lease expiry; either way the write is sent once.
    await ctx.worker.runOnce();
    ctx.clock.advance(15_000);
    await ctx.worker.drain();
    expect(await status(ctx, p)).toBe('SUCCEEDED');
    expect(ctx.meta.outboundWrites).toHaveLength(1);
  });

  it('unexpected non-domain errors release the job for retry with a generic message', async () => {
    const ctx = await makeSystem();
    const p = await queued(ctx, [await setDailyBudget(ctx.sys, 'adset_demo', 1100)]);
    const real = ctx.store.acquireLock.bind(ctx.store);
    ctx.store.acquireLock = async () => {
      throw new Error('secret connection string postgres://user:pw@host');
    };
    await ctx.worker.runOnce();
    ctx.store.acquireLock = real;
    const jobs = (ctx.store as unknown as { ops: { d: { jobs: { last_error: string | null }[] } } }).ops.d.jobs;
    expect(jobs[0]!.last_error).toBe('internal_error');
    expect(await status(ctx, p)).toBe('QUEUED');
  });
});

describe('worker: per-action guards', () => {
  it('drift on a later action detected right before sending it → PARTIAL', async () => {
    const ctx = await makeSystem();
    const p = await queued(ctx, [await setDailyBudget(ctx.sys, 'adset_demo', 1100, 'a1'), await setDailyBudget(ctx.sys, 'adset_demo_2', 1600, 'a2')]);
    ctx.worker.afterAction = async (id) => {
      if (id === 'a1') ctx.meta.externalEdit(p.ad_account_id, 'adset_demo_2', { daily_budget_minor: 1400 });
    };
    await ctx.worker.drain();
    ctx.worker.afterAction = null;
    const r = await ctx.store.getReceipt(p.tenant_id, p.proposal_id, 1);
    expect(r?.final_status).toBe('PARTIAL');
    expect(r?.actions[1]).toMatchObject({ status: 'failed', error_code: 'REMOTE_DRIFT' });
    expect(ctx.meta.outboundWrites).toHaveLength(1);
  });

  it('remote read failing right before a mutation fails that action without sending', async () => {
    const ctx = await makeSystem();
    const p = await queued(ctx, [await setDailyBudget(ctx.sys, 'adset_demo', 1100)]);
    ctx.meta.inject({ op: 'read', fault: 'rate_limit', match: (r) => 'entity_id' in r && r.entity_id === 'adset_demo' });
    await ctx.worker.drain();
    const r = await ctx.store.getReceipt(p.tenant_id, p.proposal_id, 1);
    expect(r?.actions[0]).toMatchObject({ status: 'failed', error_code: 'RATE_LIMITED' });
    expect(ctx.meta.outboundWrites).toHaveLength(0);
  });

  it('two pre-existing entities with our idempotency tag → never creates, NEEDS_REVIEW', async () => {
    const ctx = await makeSystem();
    const p = await queued(ctx, createHierarchy());
    const tag = idempotencyKey(p.tenant_id, p.proposal_id, 1, 'c1').slice(0, 16);
    const ghost = (id: string): RemoteEntity => ({ entity_id: id, entity_type: 'campaign', parent_id: null, name: `x${tagSuffix(tag)}`, status: 'PAUSED', daily_budget_minor: null, lifetime_budget_minor: null, currency: 'USD', updated_at: '2026-10-21T00:00:00Z' });
    ctx.meta.seed(p.ad_account_id, [ghost('g1'), ghost('g2')]);
    await ctx.worker.drain();
    expect(await status(ctx, p)).toBe('NEEDS_REVIEW');
    expect(ctx.meta.outboundWrites).toHaveLength(0);
  });

  it('remote unreadable during reconcile → NEEDS_REVIEW (no proof, no retry)', async () => {
    const ctx = await makeSystem();
    ctx.meta.inject({ op: 'update', fault: 'timeout_before_commit' });
    const p = await queued(ctx, [await setDailyBudget(ctx.sys, 'adset_demo', 1100)]);
    const realGet = ctx.meta.getEntity.bind(ctx.meta);
    let reads = 0;
    ctx.meta.getEntity = async (a, id) => {
      reads++;
      if (reads > 1) throw new AdapterError('network', 'down');
      return realGet(a, id);
    };
    await ctx.worker.drain();
    expect(await status(ctx, p)).toBe('NEEDS_REVIEW');
    const audit = await ctx.store.listAudit(p.tenant_id, { correlation_id: p.proposal_id });
    expect(audit.find((e) => e.event_type === 'execution.reconciled_action')?.summary).toMatch(/Không đọc được/);
  });
});

describe('worker: lifetime budget and status paths with reconcile', () => {
  async function withLifetimeAdset(ctx: Ctx) {
    ctx.meta.seed('act_demo', [{ entity_id: 'adset_life', entity_type: 'adset', parent_id: 'cmp_demo_1', name: 'Lifetime', status: 'PAUSED', daily_budget_minor: null, lifetime_budget_minor: 10_000, currency: 'USD', updated_at: '2026-10-19T00:00:00Z' }]);
    const e = await remote(ctx.sys, 'adset_life');
    return {
      action_id: 'l1',
      kind: 'SET_LIFETIME_BUDGET' as const,
      entity_type: 'adset' as const,
      entity_id: 'adset_life',
      before: { amount_minor: 10_000, currency: 'USD' },
      after: { amount_minor: 11_000, currency: 'USD' },
      depends_on: [],
      preconditions: { status: e.status, remote_fingerprint: remoteFingerprint(e) },
    };
  }

  it('lifetime budget update executes and verifies', async () => {
    const ctx = await makeSystem();
    const p = await queued(ctx, [await withLifetimeAdset(ctx)]);
    await ctx.worker.drain();
    expect(await status(ctx, p)).toBe('SUCCEEDED');
    expect((await remote(ctx.sys, 'adset_life')).lifetime_budget_minor).toBe(11_000);
  });

  it('lifetime update lost response → reconcile SUCCEEDED; status update lost response → reconcile SUCCEEDED', async () => {
    const ctx = await makeSystem();
    ctx.meta.inject({ op: 'update', fault: 'timeout_after_commit', times: 2 });
    const p = await queued(ctx, [await withLifetimeAdset(ctx)]);
    await ctx.worker.drain();
    expect(await status(ctx, p)).toBe('SUCCEEDED');

    // Status: create + verify first, then pause → activate with a lost response.
    const created = await queued(ctx, createHierarchy('2026-10-23T07:00:00Z'));
    await ctx.worker.drain();
    const cmp = (await ctx.store.getReceipt(created.tenant_id, created.proposal_id, 1))!.local_ref_map.cmp_new!;
    ctx.clock.advance(86_400_000 + 1);
    await ctx.store.putSnapshot({ ...(await ctx.store.getSnapshots(created.tenant_id, ['snapshot_demo']))[0]!, fetched_at: ctx.clock.now().toISOString() });
    const act = await queued(ctx, [await setStatus(ctx.sys, cmp, 'ACTIVE')]);
    await ctx.worker.drain();
    expect(await status(ctx, act)).toBe('SUCCEEDED');
    expect((await remote(ctx.sys, cmp)).status).toBe('ACTIVE');
  });

  it('status update that never applied → reconcile FAILED', async () => {
    const ctx = await makeSystem();
    const created = await queued(ctx, createHierarchy());
    await ctx.worker.drain();
    const cmp = (await ctx.store.getReceipt(created.tenant_id, created.proposal_id, 1))!.local_ref_map.cmp_new!;
    ctx.clock.advance(86_400_000 + 1);
    await ctx.store.putSnapshot({ ...(await ctx.store.getSnapshots(created.tenant_id, ['snapshot_demo']))[0]!, fetched_at: ctx.clock.now().toISOString() });
    ctx.meta.inject({ op: 'update', fault: 'timeout_before_commit' });
    const act = await queued(ctx, [await setStatus(ctx.sys, cmp, 'ACTIVE')]);
    await ctx.worker.drain();
    expect(await status(ctx, act)).toBe('FAILED');
    expect((await remote(ctx.sys, cmp)).status).toBe('PAUSED');
  });
});

describe('reconcile job kind', () => {
  it('UNKNOWN proposal reconciled through a queued reconcile job (runs even when frozen)', async () => {
    const ctx = await makeSystem();
    const p = await queued(ctx, [await setDailyBudget(ctx.sys, 'adset_demo', 1100)]);
    // Simulate a worker that died right after recording UNKNOWN (before its own reconcile).
    rawProposals(ctx.store).find((x) => x.proposal_id === p.proposal_id)!.status = 'UNKNOWN';
    await ctx.sys.ops.freeze(ctx.people.u_operator!, 'đang điều tra');
    const { job_id } = await ctx.sys.execution.requestReconcile(ctx.people.u_operator!, p.proposal_id, 1);
    expect(job_id).toBeTruthy();
    await ctx.worker.drain();
    // No attempts exist → nothing unresolved → no successful action → FAILED, and still zero writes.
    expect(await status(ctx, p)).toBe('FAILED');
    expect(ctx.meta.outboundWrites).toHaveLength(0);
    await expect(ctx.sys.execution.requestReconcile(ctx.people.u_operator!, 'nope', 1)).rejects.toThrow();
  });
});

describe('approval/proposal service edges', () => {
  it('APPROVED without any approval record is not executable', async () => {
    const ctx = await makeSystem();
    const { proposal } = await ctx.sys.proposals.propose(ctx.people.u_analyst!, proposeInput([await setDailyBudget(ctx.sys, 'adset_demo', 1100)]));
    await ctx.store.casProposalStatus(proposal.tenant_id, proposal.proposal_id, 1, 'PENDING_APPROVAL', 'APPROVED');
    await expect(ctx.sys.execution.request(ctx.people.u_analyst!, proposal.proposal_id, 1, proposal.payload_hash)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await expect(ctx.sys.approvals.status(ctx.people.u_analyst!, 'nope', 1)).rejects.toThrow();
    await expect(ctx.sys.approvals.decide(ctx.people.u_approver!, 'nope', 1, 'a'.repeat(64), 'approved', null)).rejects.toThrow();
  });

  it('approval status reports expiry', async () => {
    const ctx = await makeSystem();
    const p = await proposeAndApprove(ctx, [await setDailyBudget(ctx.sys, 'adset_demo', 1100)]);
    expect(await ctx.sys.approvals.status(ctx.people.u_analyst!, p.proposal_id, 1)).toBe('approved');
    ctx.clock.advance(31 * 60_000);
    expect(await ctx.sys.approvals.status(ctx.people.u_analyst!, p.proposal_id, 1)).toBe('expired');
  });

  it('revising a blocked DRAFT keeps it as history; get by revision; list by account', async () => {
    const ctx = await makeSystem();
    const blocked = await ctx.sys.proposals.propose(ctx.people.u_analyst!, proposeInput([await setDailyBudget(ctx.sys, 'adset_demo', 5000)]));
    expect(blocked.proposal.status).toBe('DRAFT');
    const fixed = await ctx.sys.proposals.propose(ctx.people.u_analyst!, proposeInput([await setDailyBudget(ctx.sys, 'adset_demo', 1100)], { proposal_id: blocked.proposal.proposal_id }));
    expect(fixed.proposal).toMatchObject({ revision: 2, status: 'PENDING_APPROVAL' });
    expect((await ctx.sys.proposals.get(ctx.people.u_viewer!, blocked.proposal.proposal_id, 1))?.proposal.status).toBe('DRAFT');
    expect(await ctx.sys.proposals.list(ctx.people.u_viewer!, 'act_demo')).toHaveLength(2);
    expect(await ctx.sys.proposals.list(ctx.people.u_viewer!, 'act_other')).toHaveLength(0);
  });
});
