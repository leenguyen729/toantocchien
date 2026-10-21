import { describe, expect, it } from 'vitest';
import { createHierarchy, makeSystem, proposeAndApprove, remote, setDailyBudget } from '../helpers';

async function runHierarchy(fault?: Parameters<NonNullable<Awaited<ReturnType<typeof makeSystem>>['meta']>['inject']>[0]) {
  const ctx = await makeSystem();
  if (fault) ctx.meta.inject(fault);
  const p = await proposeAndApprove(ctx, createHierarchy());
  await ctx.sys.execution.request(ctx.people.u_analyst!, p.proposal_id, 1, p.payload_hash);
  await ctx.worker.drain();
  const receipt = await ctx.store.getReceipt(p.tenant_id, p.proposal_id, 1);
  const proposal = await ctx.store.getProposal(p.tenant_id, p.proposal_id, 1);
  return { ...ctx, p, receipt: receipt!, status: proposal!.status };
}

describe('uncertain outcomes', () => {
  it('timeout BEFORE remote commit → UNKNOWN → NEEDS_REVIEW; create is never blind-retried', async () => {
    const r = await runHierarchy({ op: 'create', fault: 'timeout_before_commit' });
    expect(r.status).toBe('NEEDS_REVIEW');
    expect(r.meta.outboundWrites).toHaveLength(1);
    expect(r.receipt.actions.map((a) => a.status)).toEqual(['unknown', 'skipped', 'skipped']);
    expect(r.receipt.recovery_plan.join(' ')).toMatch(/KHÔNG tạo lại/);
    // Reservation is kept until a human resolves it.
    expect((await r.store.sumActiveReservations(r.p.tenant_id, r.p.ad_account_id)).daily_minor).toBe(1000);
    const audit = await r.store.listAudit(r.p.tenant_id, { correlation_id: r.p.proposal_id });
    expect(audit.map((e) => e.event_type)).toEqual(expect.arrayContaining(['execution.action_unknown', 'execution.reconciling', 'execution.reconcile_finished']));
  });

  it('timeout AFTER remote commit → reconcile finds it by tag → but stops the batch → PARTIAL', async () => {
    const r = await runHierarchy({ op: 'create', fault: 'timeout_after_commit' });
    expect(r.status).toBe('PARTIAL');
    expect(r.receipt.actions[0]).toMatchObject({ status: 'succeeded', readback_verified: true });
    expect(r.receipt.actions.slice(1).map((a) => a.status)).toEqual(['skipped', 'skipped']);
    expect(r.receipt.local_ref_map.cmp_new).toBeTruthy();
    expect(r.meta.outboundWrites.filter((w) => w.committed)).toHaveLength(1);
    expect((await remote(r.sys, r.receipt.local_ref_map.cmp_new!)).status).toBe('PAUSED');
  });

  it('provider-side duplicate with a normal response is caught → NEEDS_REVIEW, never silently picks one', async () => {
    const r = await runHierarchy({ op: 'create', fault: 'duplicate_commit' });
    expect(r.status).toBe('NEEDS_REVIEW');
    expect(r.receipt.actions.map((a) => a.status)).toEqual(['unknown', 'skipped', 'skipped']);
    const audit = await r.store.listAudit(r.p.tenant_id, { correlation_id: r.p.proposal_id });
    expect(audit.map((e) => e.event_type)).toContain('execution.duplicate_detected');
  });

  it('duplicate commit + lost response → reconcile sees 2 tagged entities → NEEDS_REVIEW', async () => {
    const ctx = await makeSystem();
    const { sys, people, meta, store, worker } = ctx;
    const realCreate = meta.create.bind(meta);
    let first = true;
    meta.create = async (acct, req) => {
      if (first) {
        first = false;
        meta.inject({ op: 'create', fault: 'duplicate_commit' });
        await realCreate(acct, req);
        throw Object.assign(new (await import('@pod/adapter-meta')).AdapterError('timeout', 'lost response'));
      }
      return realCreate(acct, req);
    };
    const p = await proposeAndApprove(ctx, createHierarchy());
    await sys.execution.request(people.u_analyst!, p.proposal_id, 1, p.payload_hash);
    await worker.drain();
    expect((await store.getProposal(p.tenant_id, p.proposal_id, 1))?.status).toBe('NEEDS_REVIEW');
    const audit = await store.listAudit(p.tenant_id, { correlation_id: p.proposal_id });
    expect(audit.find((e) => e.event_type === 'execution.reconciled_action')?.summary).toMatch(/2 bản trùng/);
  });

  it('update timeout after commit → reconcile reads after-value → SUCCEEDED', async () => {
    const ctx = await makeSystem();
    ctx.meta.inject({ op: 'update', fault: 'timeout_after_commit' });
    const p = await proposeAndApprove(ctx, [await setDailyBudget(ctx.sys, 'adset_demo', 1100)]);
    await ctx.sys.execution.request(ctx.people.u_analyst!, p.proposal_id, 1, p.payload_hash);
    await ctx.worker.drain();
    expect((await ctx.store.getProposal(p.tenant_id, p.proposal_id, 1))?.status).toBe('SUCCEEDED');
    expect((await ctx.store.sumActiveReservations(p.tenant_id, p.ad_account_id)).daily_minor).toBe(0);
  });

  it('update timeout before commit → reconcile sees before-value → FAILED (not applied), no retry', async () => {
    const ctx = await makeSystem();
    ctx.meta.inject({ op: 'update', fault: 'timeout_before_commit' });
    const p = await proposeAndApprove(ctx, [await setDailyBudget(ctx.sys, 'adset_demo', 1100)]);
    await ctx.sys.execution.request(ctx.people.u_analyst!, p.proposal_id, 1, p.payload_hash);
    await ctx.worker.drain();
    expect((await ctx.store.getProposal(p.tenant_id, p.proposal_id, 1))?.status).toBe('FAILED');
    expect(ctx.meta.outboundWrites).toHaveLength(1);
    expect((await remote(ctx.sys, 'adset_demo')).daily_budget_minor).toBe(1000);
  });

  it('update timeout then someone else edits → reconcile cannot prove → NEEDS_REVIEW', async () => {
    const ctx = await makeSystem();
    const p = await proposeAndApprove(ctx, [await setDailyBudget(ctx.sys, 'adset_demo', 1100)]);
    await ctx.sys.execution.request(ctx.people.u_analyst!, p.proposal_id, 1, p.payload_hash);
    const real = ctx.meta.update.bind(ctx.meta);
    ctx.meta.update = async () => {
      ctx.meta.externalEdit(p.ad_account_id, 'adset_demo', { daily_budget_minor: 1234 });
      throw new (await import('@pod/adapter-meta')).AdapterError('timeout', 'x');
    };
    await ctx.worker.drain();
    ctx.meta.update = real;
    expect((await ctx.store.getProposal(p.tenant_id, p.proposal_id, 1))?.status).toBe('NEEDS_REVIEW');
  });

  it('partial batch: second create rejected → PARTIAL, dependents skipped, first stays PAUSED, recovery plan', async () => {
    const r = await runHierarchy({ op: 'create', fault: 'validation_error', match: (req) => 'entity_type' in req && req.entity_type === 'adset' });
    expect(r.status).toBe('PARTIAL');
    expect(r.receipt.actions.map((a) => a.status)).toEqual(['succeeded', 'failed', 'skipped']);
    expect(r.receipt.recovery_plan.join(' ')).toMatch(/PAUSED/);
    expect(r.receipt.recovery_plan.join(' ')).toMatch(/không hoàn lại tiền/);
    expect((await r.store.sumActiveReservations(r.p.tenant_id, r.p.ad_account_id)).daily_minor).toBe(0);
  });

  it('first action failing → FAILED', async () => {
    const r = await runHierarchy({ op: 'create', fault: 'rate_limit' });
    expect(r.status).toBe('FAILED');
    expect(r.receipt.actions[0]).toMatchObject({ status: 'failed', error_code: 'RATE_LIMITED' });
  });

  it('auth error → FAILED with an incident, no freeze decided automatically', async () => {
    const r = await runHierarchy({ op: 'create', fault: 'auth_error' });
    expect(r.status).toBe('FAILED');
    const incidents = await r.store.listIncidents(r.p.tenant_id);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ severity: 'sev2', containment: { writes_frozen: false } });
  });

  it('reconcile on non-UNKNOWN returns receipt or refuses', async () => {
    const ctx = await makeSystem();
    const p = await proposeAndApprove(ctx, [await setDailyBudget(ctx.sys, 'adset_demo', 1100)]);
    await expect(ctx.worker.reconcile({ actor_id: 'x', tenant_id: p.tenant_id, kind: 'system' }, p.tenant_id, p.proposal_id, 1)).rejects.toThrow(/UNKNOWN/);
    await expect(ctx.sys.execution.requestReconcile(ctx.people.u_analyst!, p.proposal_id, 1)).rejects.toThrow(/UNKNOWN/);
    await ctx.sys.execution.request(ctx.people.u_analyst!, p.proposal_id, 1, p.payload_hash);
    await ctx.worker.drain();
    const r = await ctx.worker.reconcile({ actor_id: 'x', tenant_id: p.tenant_id, kind: 'system' }, p.tenant_id, p.proposal_id, 1);
    expect(r.final_status).toBe('SUCCEEDED');
    await expect(ctx.worker.reconcile({ actor_id: 'x', tenant_id: p.tenant_id, kind: 'system' }, p.tenant_id, 'nope', 1)).rejects.toThrow();
  });
});
