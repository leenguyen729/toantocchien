import { describe, expect, it } from 'vitest';
import { recoveryChecklist } from '@pod/domain';
import { createHierarchy, makeSystem, proposeAndApprove, setDailyBudget } from '../helpers';

describe('recovery', () => {
  it('audit store unavailable → writes fail closed, zero outbound mutations', async () => {
    const ctx = await makeSystem();
    const { sys, people, meta, worker, store } = ctx;
    const p = await proposeAndApprove(ctx, [await setDailyBudget(sys, 'adset_demo', 1100)]);
    await sys.execution.request(people.u_analyst!, p.proposal_id, 1, p.payload_hash);
    store.setAuditAvailable(false);
    await worker.drain(3);
    expect(meta.outboundWrites).toHaveLength(0);
    await expect(sys.proposals.propose(people.u_analyst!, { ad_account_id: 'act_demo', store_id: 'store_demo', actions: [await setDailyBudget(sys, 'adset_demo_2', 1600)], reason: 'x', rollback_plan: 'y', source_snapshot_ids: ['snapshot_demo'] })).rejects.toMatchObject({ code: 'WRITE_FROZEN' });
    store.setAuditAvailable(true);
  });

  it('restore from backup comes back frozen and never replays a create', async () => {
    const ctx = await makeSystem();
    const { sys, people, meta, worker, store, clock } = ctx;
    const p = await proposeAndApprove(ctx, createHierarchy());
    await sys.execution.request(people.u_analyst!, p.proposal_id, 1, p.payload_hash);
    const backup = store.exportState(); // taken while QUEUED, before the worker ran
    await worker.drain();
    expect(meta.outboundWrites.filter((w) => w.committed)).toHaveLength(3);

    store.importState(backup, clock.now().toISOString());
    expect((await store.getFreeze(p.tenant_id)).frozen).toBe(true);
    await worker.drain();
    expect(meta.outboundWrites.filter((w) => w.committed)).toHaveLength(3);

    // Owner reopens after review; worker re-runs the restored job but adopts existing entities by tag.
    await sys.ops.unfreeze(people.u_owner!, 'Đã đối soát sau restore', true);
    clock.advance(60_000);
    await worker.drain();
    expect(meta.outboundWrites.filter((w) => w.committed)).toHaveLength(3);
    const audit = await store.listAudit(p.tenant_id, { correlation_id: p.proposal_id });
    expect(audit.filter((e) => e.event_type === 'execution.create_adopted')).toHaveLength(3);
    expect((await store.getProposal(p.tenant_id, p.proposal_id, 1))?.status).toBe('SUCCEEDED');
  });

  it('token revoked mid-flight → FAILED + incident; jobs already done are not replayed', async () => {
    const ctx = await makeSystem();
    const { sys, people, meta, worker, store } = ctx;
    const p = await proposeAndApprove(ctx, [await setDailyBudget(sys, 'adset_demo', 1100)]);
    meta.inject({ op: 'update', fault: 'auth_error' });
    await sys.execution.request(people.u_analyst!, p.proposal_id, 1, p.payload_hash);
    await worker.drain();
    expect((await store.getProposal(p.tenant_id, p.proposal_id, 1))?.status).toBe('FAILED');
    expect(await store.listIncidents(p.tenant_id)).toHaveLength(1);
    await worker.drain();
    expect(meta.outboundWrites).toHaveLength(1);
  });

  it('recovery checklists are deterministic and always require owner sign-off', () => {
    for (const k of ['connector_error', 'data_stale', 'permission_lost', 'spend_anomaly', 'unknown_mutation', 'audit_unavailable', 'other'] as const) {
      expect(recoveryChecklist(k).join(' ')).toMatch(/Owner xác nhận/);
    }
    expect(recoveryChecklist('spend_anomaly').join(' ')).toMatch(/không phải trần chi tiêu/);
  });

  it('incident with freeze request contains writes and records evidence without secrets', async () => {
    const { sys, people } = await makeSystem();
    const r = await sys.ops.createIncident(people.u_operator!, 'spend_anomaly', 'Spend 3x so với budget fixture', ['act_demo'], true);
    expect(r.freeze.frozen).toBe(true);
    expect(r.incident).toMatchObject({ severity: 'sev2', state: 'contained', containment: { writes_frozen: true } });
    expect(r.incident.containment.note).toMatch(/VẪN TIẾP TỤC/);
    const resolved = await sys.ops.resolveIncident(people.u_operator!, r.incident.incident_id, 'Owner pause trong Ads Manager');
    expect(resolved.state).toBe('resolved');
    await expect(sys.ops.resolveIncident(people.u_operator!, 'inc_nope', 'x')).rejects.toThrow();
    const h = await sys.ops.health(people.u_operator!);
    expect(h.open_incidents).toBe(0);
  });
});
