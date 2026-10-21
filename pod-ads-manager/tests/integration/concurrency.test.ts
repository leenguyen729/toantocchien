import { describe, expect, it } from 'vitest';
import { ExecutionWorker, lockScope } from '@pod/domain';
import { makeSystem, proposeAndApprove, remote, setDailyBudget } from '../helpers';

describe('concurrency', () => {
  it('two concurrent requests cannot both pass the daily cap (reservation race)', async () => {
    const ctx = await makeSystem({ configOverrides: { caps: { daily_budget_cap_minor: 2700, lifetime_budget_cap_minor: 100000, proposal_exposure_cap_minor: 10000 } } });
    const { sys, people, meta } = ctx;
    // Current total 2500; each proposal adds 150 → only one fits under 2700.
    const a = await proposeAndApprove(ctx, [await setDailyBudget(sys, 'adset_demo', 1150)]);
    const b = await proposeAndApprove(ctx, [await setDailyBudget(sys, 'adset_demo_2', 1650)]);
    const results = await Promise.allSettled([
      sys.execution.request(people.u_analyst!, a.proposal_id, 1, a.payload_hash),
      sys.execution.request(people.u_analyst!, b.proposal_id, 1, b.payload_hash),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad[0]!.reason).toMatchObject({ code: 'BUDGET_CAP_EXCEEDED' });
    expect(await sys.deps.store.sumActiveReservations(a.tenant_id, a.ad_account_id)).toEqual({ daily_minor: 150, lifetime_minor: 0 });
    await sys.worker!.drain();
    expect(meta.outboundWrites.filter((w) => w.committed)).toHaveLength(1);
    expect(await sys.deps.store.sumActiveReservations(a.tenant_id, a.ad_account_id)).toEqual({ daily_minor: 0, lifetime_minor: 0 });
  });

  it('two workers on the same queue: exactly one write', async () => {
    const ctx = await makeSystem();
    const { sys, people, meta } = ctx;
    const w2 = new ExecutionWorker(sys.deps, { workerId: 'worker-2' });
    const p = await proposeAndApprove(ctx, [await setDailyBudget(sys, 'adset_demo', 1100)]);
    await sys.execution.request(people.u_analyst!, p.proposal_id, 1, p.payload_hash);
    await Promise.all([sys.worker!.drain(), w2.drain()]);
    expect(meta.outboundWrites.filter((w) => w.committed)).toHaveLength(1);
    expect((await sys.deps.store.getProposal(p.tenant_id, p.proposal_id, 1))?.status).toBe('SUCCEEDED');
  });

  it('stale lock holder (lease expired, another worker took over) cannot send further mutations', async () => {
    const ctx = await makeSystem();
    const { sys, people, meta, clock, store } = ctx;
    const w1 = new ExecutionWorker(sys.deps, { workerId: 'w1', lockTtlMs: 1000 });
    const p = await proposeAndApprove(ctx, [await setDailyBudget(sys, 'adset_demo', 1100, 'a1'), await setDailyBudget(sys, 'adset_demo_2', 1600, 'a2')]);
    await sys.execution.request(people.u_analyst!, p.proposal_id, 1, p.payload_hash);
    // After the first action, w1 stalls past its lock TTL and w2 grabs the lock.
    w1.afterAction = async () => {
      clock.advance(5000);
      await store.acquireLock(lockScope(p.tenant_id, p.ad_account_id), 'w2', clock.now().toISOString(), 60_000);
    };
    await w1.runOnce();
    expect(meta.outboundWrites.filter((w) => w.committed)).toHaveLength(1);
    expect((await remote(sys, 'adset_demo_2')).daily_budget_minor).toBe(1500);
    const receipt = await store.getReceipt(p.tenant_id, p.proposal_id, 1);
    expect(receipt?.final_status).toBe('PARTIAL');
    expect(receipt?.actions.find((a) => a.action_id === 'a2')).toMatchObject({ status: 'skipped', error_code: 'REMOTE_UNKNOWN' });
  });

  it('busy account lock defers the job instead of running in parallel', async () => {
    const ctx = await makeSystem();
    const { sys, people, meta, clock, store } = ctx;
    const p = await proposeAndApprove(ctx, [await setDailyBudget(sys, 'adset_demo', 1100)]);
    await sys.execution.request(people.u_analyst!, p.proposal_id, 1, p.payload_hash);
    await store.acquireLock(lockScope(p.tenant_id, p.ad_account_id), 'someone-else', clock.now().toISOString(), 60_000);
    await sys.worker!.runOnce();
    expect(meta.outboundWrites).toHaveLength(0);
    expect((await store.getProposal(p.tenant_id, p.proposal_id, 1))?.status).toBe('QUEUED');
    clock.advance(61_000);
    await sys.worker!.drain();
    expect((await store.getProposal(p.tenant_id, p.proposal_id, 1))?.status).toBe('SUCCEEDED');
  });

  it('a crashed worker mid-call (pending ledger row) is reconciled by the next worker, not re-sent', async () => {
    const ctx = await makeSystem();
    const { sys, people, meta, clock, store } = ctx;
    const p = await proposeAndApprove(ctx, [await setDailyBudget(sys, 'adset_demo', 1100)]);
    await sys.execution.request(people.u_analyst!, p.proposal_id, 1, p.payload_hash);
    // Simulate crash after the remote committed but before the outcome was recorded.
    const realUpdate = meta.update.bind(meta);
    meta.update = async (acct, req) => {
      await realUpdate(acct, req);
      throw new Error('process crashed');
    };
    const w1 = new ExecutionWorker(sys.deps, { workerId: 'w1', leaseMs: 1000, lockTtlMs: 1000 });
    await w1.runOnce();
    meta.update = realUpdate;
    // Outcome recorded as unknown (non-AdapterError) → reconciled to SUCCEEDED from readback.
    expect((await store.getProposal(p.tenant_id, p.proposal_id, 1))?.status).toBe('SUCCEEDED');
    clock.advance(2000);
    await sys.worker!.drain();
    expect(meta.outboundWrites.filter((w) => w.committed)).toHaveLength(1);
  });
});
