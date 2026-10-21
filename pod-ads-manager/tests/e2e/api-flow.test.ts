import { describe, expect, it } from 'vitest';
import { makeApi } from '../api-helpers';

describe('API mock E2E: mock analyst (Claude principal) draft → human approve → simulate → receipt', () => {
  it('full flow over HTTP', async () => {
    const api = await makeApi();
    const analyst = await api.as('u_analyst');
    const approver = await api.as('u_approver');

    const status = await analyst('GET', '/api/status');
    expect(status.body).toMatchObject({ mode: 'mock', live_writes_enabled: false, meta_adapter: 'mock' });
    expect(status.body.running_ads_note).toMatch(/VẪN TIẾP TỤC/);

    const draft = await analyst('POST', '/api/mock/analyst/draft', { entity_id: 'adset_demo', new_daily_budget_minor: 1100 });
    expect(draft.status).toBe(200);
    expect(draft.body.status).toBe('ok');
    const { proposal_id, revision, payload_hash } = draft.body.data;

    const detail = await approver('GET', `/api/proposals/${proposal_id}`);
    expect(detail.body.proposal).toMatchObject({ status: 'PENDING_APPROVAL', created_by: 'claude_runtime', created_by_kind: 'llm' });
    expect(detail.body.proposal.actions[0]).toMatchObject({ before: { amount_minor: 1000 }, after: { amount_minor: 1100 } });

    const dec = await approver('POST', `/api/proposals/${proposal_id}/revisions/${revision}/decision`, { decision: 'approved', expected_payload_hash: payload_hash });
    expect(dec.status).toBe(200);
    expect(dec.body.signature).toBeUndefined();

    const ex = await analyst('POST', `/api/proposals/${proposal_id}/revisions/${revision}/execute`, { expected_payload_hash: payload_hash });
    expect(ex.status).toBe(200);
    await analyst('POST', '/api/mock/worker/drain');

    const done = await approver('GET', `/api/proposals/${proposal_id}`);
    expect(done.body.proposal.status).toBe('SUCCEEDED');
    expect(done.body.receipt).toMatchObject({ final_status: 'SUCCEEDED', simulated: true });
    expect(done.body.attempts[0].idempotency_key).toBeUndefined();
    expect(done.body.audit.map((e: { event_type: string }) => e.event_type)).toEqual(
      expect.arrayContaining(['proposal.created', 'proposal.submitted', 'approval.approved', 'execution.queued', 'execution.started', 'execution.attempt_started', 'execution.action_succeeded', 'execution.finished']),
    );
    const dash = await approver('GET', '/api/dashboard');
    expect(dash.body.remote.source).toBe('mock_simulator');
    expect(dash.body.remote.entities.find((e: { entity_id: string }) => e.entity_id === 'adset_demo').daily_budget_minor).toBe(1100);
    expect(dash.body.config).toMatchObject({ account_currency: 'USD', account_timezone: 'America/Los_Angeles' });
    expect(dash.body.snapshots[0]).toHaveProperty('attribution');
  });

  it('error mapping, auth, reject, cancel, freeze, incidents, config, tools', async () => {
    const api = await makeApi();
    expect((await api.anon('GET', '/api/status')).status).toBe(403);
    expect((await api.anon('POST', '/api/auth/mock-login', { actor_id: 'nobody' })).status).toBe(403);
    expect((await api.anon('POST', '/api/auth/mock-login', { actor_id: 'u_owner', role: 'owner' })).status).toBe(400);
    expect((await api.anon('GET', '/api/health')).body).toEqual({ ok: true });
    expect((await api.anon('GET', '/api/auth/demo-users')).body.length).toBeGreaterThan(3);
    const analyst = await api.as('u_analyst');
    const approver = await api.as('u_approver');
    const owner = await api.as('u_owner');
    const operator = await api.as('u_operator');
    const viewer = await api.as('u_viewer');

    const d = (await analyst('POST', '/api/mock/analyst/draft', { entity_id: 'adset_demo', new_daily_budget_minor: 1100 })).body.data;
    expect((await analyst('POST', `/api/proposals/${d.proposal_id}/revisions/1/decision`, { decision: 'approved', expected_payload_hash: d.payload_hash })).status).toBe(403);
    expect((await approver('POST', `/api/proposals/${d.proposal_id}/revisions/1/decision`, { decision: 'approved', expected_payload_hash: 'a'.repeat(64) })).status).toBe(409);
    expect((await approver('POST', `/api/proposals/${d.proposal_id}/revisions/0/decision`, { decision: 'approved', expected_payload_hash: d.payload_hash })).status).toBe(400);
    expect((await analyst('POST', `/api/proposals/${d.proposal_id}/revisions/1/execute`, { expected_payload_hash: d.payload_hash })).status).toBe(409);
    expect((await approver('POST', `/api/proposals/${d.proposal_id}/revisions/1/decision`, { decision: 'rejected', expected_payload_hash: d.payload_hash, comment: 'chưa đủ mẫu' })).status).toBe(200);
    expect((await approver('GET', '/api/proposals/nope')).status).toBe(400);
    expect((await viewer('GET', '/api/proposals')).body.proposals).toHaveLength(1);
    expect((await viewer('GET', '/api/audit')).status).toBe(403);
    expect((await owner('GET', '/api/audit')).body.events.length).toBeGreaterThan(0);

    const d2 = (await analyst('POST', '/api/mock/analyst/draft', { entity_id: 'adset_demo_2', new_daily_budget_minor: 1600 })).body.data;
    expect((await analyst('POST', `/api/proposals/${d2.proposal_id}/revisions/1/cancel`)).status).toBe(200);
    expect((await analyst('POST', `/api/proposals/${d2.proposal_id}/revisions/1/reconcile`)).status).toBe(400);

    expect((await viewer('POST', '/api/ops/freeze', { reason: 'x' })).status).toBe(403);
    const fr = await operator('POST', '/api/ops/freeze', { reason: 'test' });
    expect(fr.body.freeze.frozen).toBe(true);
    expect((await analyst('POST', '/api/mock/analyst/draft', { entity_id: 'adset_demo', new_daily_budget_minor: 1100 })).body.data.policy.violations[0].code).toBe('WRITE_FROZEN');
    expect((await operator('POST', '/api/ops/unfreeze', { reason: 'x' })).status).toBe(403);
    expect((await owner('POST', '/api/ops/unfreeze', { reason: 'ok' })).body.freeze.frozen).toBe(false);
    const inc = await operator('POST', '/api/ops/incidents', { kind: 'data_stale', detail: 'Insights trễ 8h', request_freeze: false });
    expect(inc.body.incident.severity).toBe('sev3');
    expect((await operator('GET', '/api/ops/incidents')).body.incidents).toHaveLength(1);
    expect((await operator('POST', `/api/ops/incidents/${inc.body.incident.incident_id}/resolve`, { resolution: 'backfill xong' })).body.state).toBe('resolved');
    expect((await owner('GET', '/api/ops/health')).body.audit_chain.ok).toBe(true);

    const versions = (await owner('GET', '/api/config')).body.versions;
    const latest = versions[versions.length - 1];
    const draftCfg = await analyst('POST', '/api/config/draft', { config_draft: { ...latest, max_change_pct: 0.15 } });
    expect(draftCfg.status).toBe(200);
    expect((await analyst('POST', '/api/config/confirm', { ad_account_id: 'act_demo', version: draftCfg.body.config.version })).status).toBe(403);
    expect((await owner('POST', '/api/config/confirm', { ad_account_id: 'act_demo', version: draftCfg.body.config.version })).body.status).toBe('confirmed');
    expect((await analyst('POST', '/api/config/draft', { config_draft: { ...latest, extra: 1 } })).status).toBe(400);

    const tools = (await api.anon('GET', '/api/tools')).body.tools;
    expect(tools.find((t: { name: string }) => t.name === 'approval.decide').llm_exposed).toBe(false);
    expect((await viewer('POST', '/api/mock/meta/fault', { op: 'create', fault: 'timeout_after_commit' })).status).toBe(403);
    expect((await operator('POST', '/api/mock/meta/fault', { op: 'create', fault: 'timeout_after_commit' })).status).toBe(200);

    // Direct human proposal through the API.
    const dash = (await analyst('GET', '/api/dashboard')).body;
    const e = dash.remote.entities.find((x: { entity_id: string }) => x.entity_id === 'adset_demo');
    const r = await analyst('POST', '/api/proposals', {
      ad_account_id: 'act_demo',
      actions: [{ action_id: 'a1', kind: 'SET_DAILY_BUDGET', entity_type: 'adset', entity_id: 'adset_demo', before: { amount_minor: e.daily_budget_minor, currency: 'USD' }, after: { amount_minor: 900, currency: 'USD' }, depends_on: [], preconditions: { status: e.status, remote_fingerprint: e.remote_fingerprint } }],
      reason: 'Giảm budget', rollback_plan: 'Khôi phục qua proposal riêng', source_snapshot_ids: ['snapshot_demo'],
    });
    expect(r.body.proposal.status).toBe('PENDING_APPROVAL');
    expect((await analyst('POST', '/api/proposals', { ad_account_id: 'act_demo', actions: [{ kind: 'DELETE' }], reason: 'x', rollback_plan: 'y', source_snapshot_ids: [] })).status).toBe(400);
    await api.app.close();
  });
});
