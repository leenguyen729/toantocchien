import { describe, expect, it } from 'vitest';
import { claudeRuntimePrincipal } from '@pod/domain';
import { ToolExecutor } from '@pod/adapter-claude';
import { makeApi } from '../api-helpers';
import { proposeInput, setDailyBudget } from '../helpers';

describe('tenant isolation', () => {
  it('another tenant cannot read, approve, execute or cancel; listings are filtered', async () => {
    const api = await makeApi();
    const { sys, people } = api;
    const { proposal } = await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo', 1100)]));
    const other = people.u_other_approver!;
    expect(await sys.proposals.get(other, proposal.proposal_id)).toBeNull();
    expect(await sys.proposals.list(other)).toHaveLength(0);
    await expect(sys.approvals.decide(other, proposal.proposal_id, 1, proposal.payload_hash, 'approved', null)).rejects.toThrow(/Không tìm thấy/);
    await expect(sys.execution.request(other, proposal.proposal_id, 1, proposal.payload_hash)).rejects.toThrow(/Không tìm thấy/);
    await expect(sys.proposals.cancel(other, proposal.proposal_id, 1)).rejects.toThrow(/Không tìm thấy/);
    expect(await sys.deps.store.listAudit(other.tenant_id)).toHaveLength(0);

    const otherHttp = await api.as('u_other_approver');
    expect((await otherHttp('GET', `/api/proposals/${proposal.proposal_id}`)).status).toBe(400);
    expect((await otherHttp('GET', '/api/proposals')).body.proposals).toHaveLength(0);
    expect((await otherHttp('GET', '/api/audit')).body.events).toHaveLength(0);
    // Freezing tenant_other does not freeze tenant_demo.
    await otherHttp('POST', '/api/ops/freeze', { reason: 'own tenant' }).catch(() => undefined);
    expect((await sys.deps.store.getFreeze(people.u_owner!.tenant_id)).frozen).toBe(false);
  });

  it('tool inputs cannot carry tenant/role overrides; principal comes from the server', async () => {
    const api = await makeApi();
    const tools = new ToolExecutor(api.sys);
    const llm = claudeRuntimePrincipal('tenant_demo', ['act_demo']);
    const budget = { maxToolCalls: 20, used: 0 };
    const r = await tools.call('context.get', { ad_account_id: 'act_demo', tenant_id: 'tenant_other' }, llm, budget);
    expect(r).toMatchObject({ status: 'failed', errors: [{ code: 'INPUT_INVALID' }] });
    const cross = await tools.call('meta.structure.read', { ad_account_id: 'act_other' }, llm, budget);
    expect(cross.errors[0]?.code).toBe('PERMISSION_DENIED');
    const cfg = await tools.call('context.get', { ad_account_id: 'act_other' }, llm, budget);
    expect(cfg.errors[0]?.code).toBe('PERMISSION_DENIED');
  });

  it('sessions: bogus, malformed and expired tokens resolve to nobody', async () => {
    const api = await makeApi();
    for (const auth of ['Bearer ' + 'f'.repeat(64), 'Bearer not-a-token', 'Basic abc', '']) {
      const r = await api.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: auth } });
      expect(r.statusCode).toBe(403);
    }
    const token = await api.login('u_viewer');
    api.clock.advance(9 * 3600_000);
    expect((await api.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(403);
    // Raw tokens are never stored.
    const raw = JSON.stringify((api.store as unknown as { ops: { d: { sessions: Map<string, unknown> } } }).ops.d.sessions.size);
    expect(raw).toBeTruthy();
    const keys = [...(api.store as unknown as { ops: { d: { sessions: Map<string, unknown> } } }).ops.d.sessions.keys()];
    expect(keys).not.toContain(token);
  });
});
