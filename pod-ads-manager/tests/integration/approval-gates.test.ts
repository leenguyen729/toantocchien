import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalize } from '@pod/contracts';
import { claudeRuntimePrincipal, signApproval } from '@pod/domain';
import { makeSystem, proposeAndApprove, proposeInput, remote, setDailyBudget, createHierarchy } from '../helpers';

/** Approval matrix (spec §10): absent/expired/forged/replayed, hash/asset drift, policy change → 100% blocked, zero outbound mutations. */
describe('approval gates', () => {
  it('absent approval: execution.request refused, nothing queued, zero writes', async () => {
    const { sys, people, meta, worker } = await makeSystem();
    const { proposal } = await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo', 1100)]));
    expect(proposal.status).toBe('PENDING_APPROVAL');
    await expect(sys.execution.request(people.u_analyst!, proposal.proposal_id, 1, proposal.payload_hash)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await worker.drain();
    expect(meta.outboundWrites).toHaveLength(0);
  });

  it('the LLM principal cannot approve and a chat "đồng ý" creates nothing', async () => {
    const { sys, people } = await makeSystem();
    const { proposal } = await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo', 1100)]));
    const llm = claudeRuntimePrincipal(proposal.tenant_id, [proposal.ad_account_id]);
    await expect(sys.approvals.decide(llm, proposal.proposal_id, 1, proposal.payload_hash, 'approved', 'đồng ý')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await sys.deps.store.listApprovals(proposal.tenant_id, proposal.proposal_id, 1)).toHaveLength(0);
  });

  it('wrong role, other account, over-limit and self-approval (SoD) are refused', async () => {
    const { sys, people } = await makeSystem();
    const { proposal } = await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo', 1100)]));
    for (const who of ['u_operator', 'u_owner', 'u_viewer', 'u_analyst']) {
      await expect(sys.approvals.decide(people[who]!, proposal.proposal_id, 1, proposal.payload_hash, 'approved', null)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    const lowLimit = { ...people.u_approver!, grants: [{ ...people.u_approver!.grants[0]!, approval_limit_minor: 10 }] };
    await expect(sys.approvals.decide(lowLimit, proposal.proposal_id, 1, proposal.payload_hash, 'approved', null)).rejects.toThrow(/hạn mức/);
    const otherCurrency = { ...people.u_approver!, grants: [{ ...people.u_approver!.grants[0]!, approval_limit_currency: 'EUR' }] };
    await expect(sys.approvals.decide(otherCurrency, proposal.proposal_id, 1, proposal.payload_hash, 'approved', null)).rejects.toThrow(/hạn mức/);
    // Separation of duties: approver who also authored the proposal.
    const both = { ...people.u_approver!, grants: [...people.u_approver!.grants, { role: 'analyst' as const, ad_account_ids: ['act_demo'] }] };
    const own = await sys.proposals.propose(both, proposeInput([await setDailyBudget(sys, 'adset_demo_2', 1600)]));
    await expect(sys.approvals.decide(both, own.proposal.proposal_id, 1, own.proposal.payload_hash, 'approved', null)).rejects.toThrow(/Separation/);
  });

  it('expired before approval → EXPIRED; expired approval before enqueue → EXPIRED; zero writes', async () => {
    const ctx = await makeSystem();
    const { sys, people, clock, meta } = ctx;
    const a = await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo', 1100)]));
    clock.advance(31 * 60_000);
    await expect(sys.approvals.decide(people.u_approver!, a.proposal.proposal_id, 1, a.proposal.payload_hash, 'approved', null)).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    expect((await sys.deps.store.getProposal(a.proposal.tenant_id, a.proposal.proposal_id, 1))?.status).toBe('EXPIRED');

    clock.advance(-31 * 60_000);
    const b = await proposeAndApprove(ctx, [await setDailyBudget(sys, 'adset_demo_2', 1600)]);
    clock.advance(31 * 60_000);
    await expect(sys.execution.request(people.u_analyst!, b.proposal_id, 1, b.payload_hash)).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    expect((await sys.deps.store.getProposal(b.tenant_id, b.proposal_id, 1))?.status).toBe('EXPIRED');
    expect(meta.outboundWrites).toHaveLength(0);
  });

  it('approval expiring while queued: worker expires the job without writing', async () => {
    const ctx = await makeSystem();
    const { sys, people, clock, meta, worker } = ctx;
    const p = await proposeAndApprove(ctx, [await setDailyBudget(sys, 'adset_demo', 1100)]);
    await sys.execution.request(people.u_analyst!, p.proposal_id, 1, p.payload_hash);
    clock.advance(31 * 60_000);
    await worker.drain();
    expect((await sys.deps.store.getProposal(p.tenant_id, p.proposal_id, 1))?.status).toBe('EXPIRED');
    expect(await sys.deps.store.sumActiveReservations(p.tenant_id, p.ad_account_id)).toEqual({ daily_minor: 0, lifetime_minor: 0 });
    expect(meta.outboundWrites).toHaveLength(0);
  });

  it('forged approval (bad signature or other key) is never accepted', async () => {
    const { sys, people, meta, worker, store } = await makeSystem();
    const { proposal } = await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo', 1100)]));
    const base = {
      approval_id: 'apr_forged', tenant_id: proposal.tenant_id, proposal_id: proposal.proposal_id, revision: 1, payload_hash: proposal.payload_hash, actor_id: 'u_approver', role: 'approver' as const,
      decision: 'approved' as const, decided_at: sys.deps.clock.now().toISOString(), expires_at: '2026-10-21T03:20:00Z', scope: { ad_account_id: proposal.ad_account_id, exposure_limit_minor: 99999, currency: 'USD' }, key_id: sys.deps.runtime.signingKey.key_id, comment: null,
    };
    await store.insertApproval({ ...base, signature: signApproval(base, Buffer.alloc(32, 7)) });
    await store.casProposalStatus(proposal.tenant_id, proposal.proposal_id, 1, 'PENDING_APPROVAL', 'APPROVED');
    await expect(sys.execution.request(people.u_analyst!, proposal.proposal_id, 1, proposal.payload_hash)).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' });
    // Same forged record but unknown key id.
    await store.insertApproval({ ...base, approval_id: 'apr_forged2', key_id: 'kX', signature: createHash('sha256').update(canonicalize(base)).digest('hex') });
    await expect(sys.execution.request(people.u_analyst!, proposal.proposal_id, 1, proposal.payload_hash)).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' });
    await worker.drain();
    expect(meta.outboundWrites).toHaveLength(0);
  });

  it('payload tampering after approval is detected by recomputed hash', async () => {
    const ctx = await makeSystem();
    const { sys, people, meta, store } = ctx;
    const p = await proposeAndApprove(ctx, [await setDailyBudget(sys, 'adset_demo', 1100)]);
    // Simulate a DB-level tamper: same row, bigger budget, old hash.
    const tampered = { ...p, status: 'APPROVED' as const, actions: [{ ...(p.actions[0] as never as Record<string, unknown>), after: { amount_minor: 1199, currency: 'USD' } }] as never };
    (store as unknown as { ops: { d: { proposals: unknown[] } } }).ops.d.proposals = [tampered];
    await expect(sys.execution.request(people.u_analyst!, p.proposal_id, 1, p.payload_hash)).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' });
    expect(meta.outboundWrites).toHaveLength(0);
  });

  it('approving with a stale displayed hash is refused', async () => {
    const { sys, people } = await makeSystem();
    const { proposal } = await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo', 1100)]));
    await expect(sys.approvals.decide(people.u_approver!, proposal.proposal_id, 1, 'e'.repeat(64), 'approved', null)).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' });
    await expect(sys.execution.request(people.u_analyst!, proposal.proposal_id, 1, 'e'.repeat(64))).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' });
  });

  it('replayed execution.request does not enqueue twice; replayed job does not write twice', async () => {
    const ctx = await makeSystem();
    const { sys, people, meta, worker, store } = ctx;
    const p = await proposeAndApprove(ctx, [await setDailyBudget(sys, 'adset_demo', 1100)]);
    const first = await sys.execution.request(people.u_analyst!, p.proposal_id, 1, p.payload_hash);
    const again = await sys.execution.request(people.u_analyst!, p.proposal_id, 1, p.payload_hash);
    expect(first.replay).toBe(false);
    expect(again.replay).toBe(true);
    expect(await store.countJobs(p.tenant_id, ['pending'])).toBe(1);
    await worker.drain();
    // Re-deliver the same job (e.g. queue replay after restore).
    await store.insertJob({ ...(await store.getJob(first.job_id!))!, status: 'pending', lease_owner: null, lease_until: null });
    await worker.drain();
    expect(meta.outboundWrites.filter((w) => w.committed)).toHaveLength(1);
    expect((await remote(sys, 'adset_demo')).daily_budget_minor).toBe(1100);
  });

  it('remote drift between approval and execution invalidates; zero writes', async () => {
    const ctx = await makeSystem();
    const { sys, people, meta, worker } = ctx;
    const p = await proposeAndApprove(ctx, [await setDailyBudget(sys, 'adset_demo', 1100)]);
    meta.externalEdit(p.ad_account_id, 'adset_demo', { daily_budget_minor: 1050 });
    await expect(sys.execution.request(people.u_analyst!, p.proposal_id, 1, p.payload_hash)).rejects.toMatchObject({ code: 'REMOTE_DRIFT' });
    expect((await sys.deps.store.getProposal(p.tenant_id, p.proposal_id, 1))?.status).toBe('INVALIDATED');
    // Drift after enqueue is caught by the worker.
    const q = await proposeAndApprove(ctx, [await setDailyBudget(sys, 'adset_demo_2', 1600)]);
    await sys.execution.request(people.u_analyst!, q.proposal_id, 1, q.payload_hash);
    meta.externalEdit(q.ad_account_id, 'adset_demo_2', { status: 'ACTIVE' });
    await worker.drain();
    expect((await sys.deps.store.getProposal(q.tenant_id, q.proposal_id, 1))?.status).toBe('INVALIDATED');
    expect(meta.outboundWrites).toHaveLength(0);
  });

  it('asset change after approval invalidates (review bound to hash)', async () => {
    const ctx = await makeSystem();
    const { sys, people, meta, worker, store } = ctx;
    const p = await proposeAndApprove(ctx, createHierarchy());
    await sys.execution.request(people.u_analyst!, p.proposal_id, 1, p.payload_hash);
    const [asset] = await store.getAssets(p.tenant_id, ['asset_demo_1']);
    await store.putAsset({ ...asset!, sha256: 'c'.repeat(64), version: 2 });
    await worker.drain();
    expect((await store.getProposal(p.tenant_id, p.proposal_id, 1))?.status).toBe('INVALIDATED');
    expect((await store.getPolicyResult(p.tenant_id, p.proposal_id, 1))?.violations.map((v) => v.rule_id)).toContain('R_ASSET_HASH');
    expect(meta.outboundWrites).toHaveLength(0);
  });

  it('policy/config change after approval invalidates (owner lowers cap)', async () => {
    const ctx = await makeSystem();
    const { sys, people, meta } = ctx;
    const p = await proposeAndApprove(ctx, [await setDailyBudget(sys, 'adset_demo', 1100)]);
    const cfg = (await sys.config.get(people.u_owner!, p.ad_account_id))!;
    const { config } = await sys.config.saveDraft(people.u_owner!, { ...cfg, caps: { ...cfg.caps, daily_budget_cap_minor: 2000 } });
    await sys.config.confirm(people.u_owner!, p.ad_account_id, config.version);
    await expect(sys.execution.request(people.u_analyst!, p.proposal_id, 1, p.payload_hash)).rejects.toMatchObject({ code: 'BUDGET_CAP_EXCEEDED' });
    expect(meta.outboundWrites).toHaveLength(0);
  });

  it('rejected proposals cannot be executed', async () => {
    const { sys, people } = await makeSystem();
    const { proposal } = await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo', 1100)]));
    await sys.approvals.decide(people.u_approver!, proposal.proposal_id, 1, proposal.payload_hash, 'rejected', 'CPA chưa đủ mẫu');
    expect(await sys.approvals.status(people.u_analyst!, proposal.proposal_id, 1)).toBe('rejected');
    await expect(sys.execution.request(people.u_analyst!, proposal.proposal_id, 1, proposal.payload_hash)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await expect(sys.approvals.decide(people.u_approver!, proposal.proposal_id, 1, proposal.payload_hash, 'approved', null)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
  });

  it('approval re-checks policy against current state', async () => {
    const { sys, people, meta } = await makeSystem();
    const { proposal } = await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo', 1100)]));
    meta.externalEdit(proposal.ad_account_id, 'adset_demo', { daily_budget_minor: 999 });
    await expect(sys.approvals.decide(people.u_approver!, proposal.proposal_id, 1, proposal.payload_hash, 'approved', null)).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
  });
});
