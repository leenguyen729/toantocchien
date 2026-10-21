import { describe, expect, it } from 'vitest';
import { makeSystem, proposeAndApprove, remote, setDailyBudget, createHierarchy, setStatus, proposeInput } from '../helpers';

describe('mock E2E: analyst draft → human approve → simulate → reconcile/receipt', () => {
  it('budget change end to end', async () => {
    const ctx = await makeSystem();
    const { sys, people, meta, worker } = ctx;
    const p = await proposeAndApprove(ctx, [await setDailyBudget(sys, 'adset_demo', 1100)]);
    expect(meta.outboundWrites).toHaveLength(0);
    const q = await sys.execution.request(people.u_analyst!, p.proposal_id, p.revision, p.payload_hash);
    expect(q.replay).toBe(false);
    expect(meta.outboundWrites).toHaveLength(0);
    await worker.drain();
    const final = await sys.deps.store.getProposal(p.tenant_id, p.proposal_id, p.revision);
    expect(final?.status).toBe('SUCCEEDED');
    expect((await remote(sys, 'adset_demo')).daily_budget_minor).toBe(1100);
    const receipt = await sys.deps.store.getReceipt(p.tenant_id, p.proposal_id, p.revision);
    expect(receipt?.final_status).toBe('SUCCEEDED');
    expect(receipt?.simulated).toBe(true);
    expect(receipt?.actions[0]?.readback_verified).toBe(true);
    const health = await sys.ops.health(people.u_owner!);
    expect(health.audit_chain.ok).toBe(true);
  });

  it('create PAUSED hierarchy, then separate activation proposal', async () => {
    const ctx = await makeSystem();
    const { sys, people, worker } = ctx;
    const p = await proposeAndApprove(ctx, createHierarchy());
    await sys.execution.request(people.u_analyst!, p.proposal_id, p.revision, p.payload_hash);
    await worker.drain();
    const receipt = await sys.deps.store.getReceipt(p.tenant_id, p.proposal_id, p.revision);
    expect(receipt?.final_status).toBe('SUCCEEDED');
    const campaignId = receipt!.local_ref_map.cmp_new!;
    expect((await remote(sys, campaignId)).status).toBe('PAUSED');

    // activation mixed with creates is blocked
    const mixed = await sys.proposals.propose(people.u_analyst!, proposeInput([...createHierarchy().map((a) => ({ ...a, action_id: `x${a.action_id}`, depends_on: a.depends_on.map((d) => `x${d}`), local_ref: `${(a as { local_ref: string }).local_ref}_2` }) as never), { ...(await setStatus(sys, campaignId, 'ACTIVE', 'act1')) }]));
    expect(mixed.policy.violations.map((v) => v.rule_id)).toContain('R_ACTIVATION_SEPARATE');

    ctx.clock.advance(86_400_000 + 1000); // past cooldown; refresh snapshot
    await sys.deps.store.putSnapshot({ ...(await sys.deps.store.getSnapshots(p.tenant_id, ['snapshot_demo']))[0]!, fetched_at: ctx.clock.now().toISOString() });
    const act = await proposeAndApprove(ctx, [await setStatus(sys, campaignId, 'ACTIVE')]);
    expect(act.risk_flags).toContain('ACTIVATES_DELIVERY');
    await sys.execution.request(people.u_approver!, act.proposal_id, act.revision, act.payload_hash);
    await worker.drain();
    expect((await remote(sys, campaignId)).status).toBe('ACTIVE');
  });
});
