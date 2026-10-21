import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExecutionWorker, ManualClock, createSystem, loadRuntimeConfig, seedDemo, verifyAuditChain } from '@pod/domain';
import { PgStore } from '@pod/domain/pg';
import { createHierarchy, proposeInput, remote, setDailyBudget } from '../../helpers';

// Runs only when DATABASE_URL is set (see vitest.config.ts). Uses a dedicated test database.
const url = process.env.DATABASE_URL!;
let store: PgStore;

beforeAll(async () => {
  store = await PgStore.connect(url);
});
afterAll(async () => {
  await store.close();
});
beforeEach(async () => {
  await store.truncateAll();
});

async function pgSystem(overrides = {}) {
  const clock = new ManualClock('2026-10-21T03:00:00Z');
  const sys = createSystem({ store, clock, runtime: loadRuntimeConfig({ EXECUTION_MODE: 'mock', LIVE_WRITES_ENABLED: 'false' }), role: 'all-in-one' });
  const people = await seedDemo(sys, overrides);
  return { sys, people, clock, meta: sys.fakeMeta!, worker: sys.worker! };
}

describe('PgStore (PostgreSQL)', () => {
  it('runs the full mock E2E on Postgres', async () => {
    const { sys, people, meta, worker } = await pgSystem();
    const { proposal } = await sys.proposals.propose(people.u_analyst!, proposeInput(createHierarchy()));
    expect(proposal.status).toBe('PENDING_APPROVAL');
    await sys.approvals.decide(people.u_approver!, proposal.proposal_id, 1, proposal.payload_hash, 'approved', null);
    await sys.execution.request(people.u_analyst!, proposal.proposal_id, 1, proposal.payload_hash);
    await worker.drain();
    const receipt = await store.getReceipt(proposal.tenant_id, proposal.proposal_id, 1);
    expect(receipt?.final_status).toBe('SUCCEEDED');
    expect(Object.keys(receipt!.local_ref_map).sort()).toEqual(['ad_new', 'adset_new', 'cmp_new']);
    expect(meta.outboundWrites.filter((w) => w.committed)).toHaveLength(3);
    expect(verifyAuditChain(await store.listAudit(proposal.tenant_id)).ok).toBe(true);
  });

  it('serialises the cap check across truly concurrent transactions', async () => {
    const ctx = await pgSystem({ configOverrides: { caps: { daily_budget_cap_minor: 2700, lifetime_budget_cap_minor: 100000, proposal_exposure_cap_minor: 10000 } } });
    const { sys, people } = ctx;
    const mk = async (id: string, after: number) => {
      const { proposal } = await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, id, after)]));
      await sys.approvals.decide(people.u_approver!, proposal.proposal_id, 1, proposal.payload_hash, 'approved', null);
      return proposal;
    };
    const a = await mk('adset_demo', 1150);
    const b = await mk('adset_demo_2', 1650);
    const res = await Promise.allSettled([
      sys.execution.request(people.u_analyst!, a.proposal_id, 1, a.payload_hash),
      sys.execution.request(people.u_analyst!, b.proposal_id, 1, b.payload_hash),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((res.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'BUDGET_CAP_EXCEEDED' });
  });

  it('SKIP LOCKED leasing: two workers, one write', async () => {
    const { sys, people, meta } = await pgSystem();
    const { proposal } = await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo', 1100)]));
    await sys.approvals.decide(people.u_approver!, proposal.proposal_id, 1, proposal.payload_hash, 'approved', null);
    await sys.execution.request(people.u_analyst!, proposal.proposal_id, 1, proposal.payload_hash);
    const w2 = new ExecutionWorker(sys.deps, { workerId: 'w2' });
    await Promise.all([sys.worker!.drain(), w2.drain()]);
    expect(meta.outboundWrites.filter((w) => w.committed)).toHaveLength(1);
    expect((await remote(sys, 'adset_demo')).daily_budget_minor).toBe(1100);
  });

  it('audit_events is append-only at the database level', async () => {
    const { people } = await pgSystem();
    const pool = (store as unknown as { pool: { query: (q: string) => Promise<unknown> } }).pool;
    await expect(pool.query("UPDATE audit_events SET correlation_id='x'")).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM audit_events')).rejects.toThrow(/append-only/);
    expect((await store.listAudit(people.u_owner!.tenant_id)).length).toBeGreaterThan(0);
  });

  it('idempotency key and proposal revision are unique; fencing enforced', async () => {
    const { sys, people } = await pgSystem();
    const { proposal } = await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo', 1100)]));
    await expect(store.insertProposal(proposal)).rejects.toThrow(/đã tồn tại/);
    const lock = (await store.acquireLock('s', 'h1', '2026-10-21T03:00:00.000Z', 1000))!;
    expect(await store.acquireLock('s', 'h2', '2026-10-21T03:00:00.500Z', 1000)).toBeNull();
    const l2 = (await store.acquireLock('s', 'h2', '2026-10-21T03:00:02.000Z', 1000))!;
    expect(l2.token).toBe(lock.token + 1);
    const att = { attempt_id: 'att1', tenant_id: 't', proposal_id: 'p', revision: 1, action_id: 'a', idempotency_key: 'a'.repeat(64), request_hash: 'b'.repeat(64), remote_request_id: null, remote_id: null, before_snapshot_ref: null, after_snapshot_ref: null, started_at: '2026-10-21T03:00:00Z', finished_at: null, sanitized_error: null, status: 'pending' as const, fencing_token: lock.token };
    await expect(store.insertAttempt(att, { scope: 's', now: '2026-10-21T03:00:02.100Z' })).rejects.toThrow(/Fencing/);
    await store.insertAttempt({ ...att, fencing_token: l2.token }, { scope: 's', now: '2026-10-21T03:00:02.100Z' });
    await expect(store.insertAttempt({ ...att, attempt_id: 'att2', fencing_token: l2.token }, { scope: 's', now: '2026-10-21T03:00:02.100Z' })).rejects.toThrow(/Idempotency/);
  });

  it('transactions roll back on error', async () => {
    const { people } = await pgSystem();
    const before = (await store.listAudit(people.u_owner!.tenant_id)).length;
    await expect(
      store.tx(async (s) => {
        await s.appendAudit({ tenant_id: people.u_owner!.tenant_id, actor_id: 'x', actor_kind: 'system', correlation_id: 'c', event_type: 'test.event', payload_hash: 'a'.repeat(64), summary: 's', occurred_at: '2026-10-21T03:00:00Z' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await store.listAudit(people.u_owner!.tenant_id)).length).toBe(before);
  });
});
