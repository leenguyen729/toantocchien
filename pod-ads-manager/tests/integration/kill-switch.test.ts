import { describe, expect, it } from 'vitest';
import { RUNNING_ADS_NOTE, claudeRuntimePrincipal } from '@pod/domain';
import { makeSystem, proposeAndApprove, proposeInput, remote, setDailyBudget } from '../helpers';

describe('kill switch (internal write freeze)', () => {
  it('blocks a job that was already queued, and resumes after owner unfreezes', async () => {
    const ctx = await makeSystem();
    const { sys, people, meta, worker, clock, store } = ctx;
    const p = await proposeAndApprove(ctx, [await setDailyBudget(sys, 'adset_demo', 1100)]);
    await sys.execution.request(people.u_analyst!, p.proposal_id, 1, p.payload_hash);
    await sys.ops.freeze(people.u_operator!, 'Spend bất thường');
    await worker.drain();
    expect(meta.outboundWrites).toHaveLength(0);
    expect((await store.getProposal(p.tenant_id, p.proposal_id, 1))?.status).toBe('QUEUED');
    expect((await store.listAudit(p.tenant_id, { correlation_id: p.proposal_id })).map((e) => e.event_type)).toContain('execution.blocked_frozen');
    await sys.ops.unfreeze(people.u_owner!, 'Đã kiểm tra');
    clock.advance(31_000);
    await worker.drain();
    expect((await remote(sys, 'adset_demo')).daily_budget_minor).toBe(1100);
  });

  it('flipping mid-batch stops the remaining actions', async () => {
    const ctx = await makeSystem();
    const { sys, people, meta, worker, store } = ctx;
    const p = await proposeAndApprove(ctx, [await setDailyBudget(sys, 'adset_demo', 1100, 'a1'), await setDailyBudget(sys, 'adset_demo_2', 1600, 'a2')]);
    await sys.execution.request(people.u_analyst!, p.proposal_id, 1, p.payload_hash);
    worker.afterAction = async () => {
      await sys.ops.freeze(people.u_operator!, 'giữa batch');
    };
    await worker.drain();
    worker.afterAction = null;
    const receipt = await store.getReceipt(p.tenant_id, p.proposal_id, 1);
    expect(receipt?.final_status).toBe('PARTIAL');
    expect(receipt?.actions[1]).toMatchObject({ status: 'skipped', error_code: 'WRITE_FROZEN' });
    expect(meta.outboundWrites.filter((w) => w.committed)).toHaveLength(1);
  });

  it('blocks new proposals and enqueue while frozen', async () => {
    const ctx = await makeSystem();
    const { sys, people } = ctx;
    const p = await proposeAndApprove(ctx, [await setDailyBudget(sys, 'adset_demo', 1100)]);
    await sys.ops.freeze(people.u_owner!, 'test');
    await expect(sys.execution.request(people.u_analyst!, p.proposal_id, 1, p.payload_hash)).rejects.toMatchObject({ code: 'WRITE_FROZEN' });
    // Freeze must not invalidate an approved proposal by itself.
    expect((await sys.deps.store.getProposal(p.tenant_id, p.proposal_id, 1))?.status).toBe('APPROVED');
    const r = await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo_2', 1600)]));
    expect(r.policy.violations.map((v) => v.rule_id)).toContain('R_FREEZE');
  });

  it('LLM and operator can freeze; only a human owner can unfreeze', async () => {
    const { sys, people } = await makeSystem();
    const llm = claudeRuntimePrincipal(people.u_owner!.tenant_id, ['act_demo']);
    const st = await sys.ops.freeze(llm, 'Claude phát hiện dữ liệu stale');
    expect(st.frozen).toBe(true);
    await expect(sys.ops.unfreeze(llm, 'x')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(sys.ops.unfreeze(people.u_operator!, 'x')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(sys.ops.freeze(people.u_viewer!, 'x')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect((await sys.ops.unfreeze(people.u_owner!, 'ok')).frozen).toBe(false);
  });

  it('never claims to stop running ads', async () => {
    const { sys, people } = await makeSystem();
    const st = await sys.ops.freeze(people.u_owner!, 'x');
    expect(st.stops_running_ads).toBe(false);
    expect(RUNNING_ADS_NOTE).toMatch(/VẪN TIẾP TỤC chi tiêu/);
    const h = await sys.ops.health(people.u_owner!);
    expect(h.running_ads_note).toBe(RUNNING_ADS_NOTE);
  });

  it('unfreeze is refused while UNKNOWN/NEEDS_REVIEW work exists unless acknowledged', async () => {
    const ctx = await makeSystem();
    const { sys, people, meta, worker } = ctx;
    meta.inject({ op: 'update', fault: 'timeout_before_commit' });
    const p = await proposeAndApprove(ctx, [await setDailyBudget(sys, 'adset_demo_2', 1600)]);
    // Force NEEDS_REVIEW: external edit during the uncertain window.
    const real = meta.update.bind(meta);
    meta.update = async (a, r) => {
      meta.externalEdit(a, 'adset_demo_2', { daily_budget_minor: 1777 });
      return real(a, r);
    };
    await sys.execution.request(people.u_analyst!, p.proposal_id, 1, p.payload_hash);
    await worker.drain();
    meta.update = real;
    expect((await sys.deps.store.getProposal(p.tenant_id, p.proposal_id, 1))?.status).toBe('NEEDS_REVIEW');
    await sys.ops.freeze(people.u_owner!, 'x');
    await expect(sys.ops.unfreeze(people.u_owner!, 'y')).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    expect((await sys.ops.unfreeze(people.u_owner!, 'đã kiểm tra Ads Manager', true)).frozen).toBe(false);
  });
});
