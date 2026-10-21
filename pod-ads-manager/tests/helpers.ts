import type { Action, RemoteEntity } from '@pod/contracts';
import { remoteFingerprint } from '@pod/policy';
import { DEMO, ManualClock, MemoryStore, createSystem, loadRuntimeConfig, seedDemo, type SeedOptions, type System } from '@pod/domain';

export async function makeSystem(opts: SeedOptions & { env?: Record<string, string> } = {}) {
  const clock = new ManualClock('2026-10-21T03:00:00Z');
  const store = new MemoryStore();
  const sys = createSystem({ store, clock, runtime: loadRuntimeConfig({ EXECUTION_MODE: 'mock', LIVE_WRITES_ENABLED: 'false', ...opts.env }), role: 'all-in-one' });
  const people = await seedDemo(sys, opts);
  return { sys, store, clock, people, meta: sys.fakeMeta!, worker: sys.worker! };
}

export async function remote(sys: System, entityId: string, account: string = DEMO.ad_account_id): Promise<RemoteEntity> {
  const e = await sys.fakeMeta!.getEntity(account, entityId);
  if (!e) throw new Error(`missing ${entityId}`);
  return e;
}

export async function setDailyBudget(sys: System, entityId: string, after: number, actionId = 'a1', account: string = DEMO.ad_account_id): Promise<Action> {
  const e = await remote(sys, entityId, account);
  return {
    action_id: actionId,
    kind: 'SET_DAILY_BUDGET',
    entity_type: e.entity_type === 'campaign' ? 'campaign' : 'adset',
    entity_id: entityId,
    before: { amount_minor: e.daily_budget_minor ?? 0, currency: e.currency },
    after: { amount_minor: after, currency: e.currency },
    depends_on: [],
    preconditions: { status: e.status, remote_fingerprint: remoteFingerprint(e) },
  };
}

export async function setStatus(sys: System, entityId: string, to: 'ACTIVE' | 'PAUSED', actionId = 'a1'): Promise<Action> {
  const e = await remote(sys, entityId);
  return {
    action_id: actionId,
    kind: 'SET_STATUS',
    entity_type: e.entity_type,
    entity_id: entityId,
    before: { status: e.status },
    after: { status: to },
    depends_on: [],
    preconditions: { status: e.status, remote_fingerprint: remoteFingerprint(e) },
  };
}

export function createHierarchy(start = '2026-10-22T07:00:00Z'): Action[] {
  return [
    {
      action_id: 'c1',
      kind: 'CREATE_CAMPAIGN_PAUSED',
      local_ref: 'cmp_new',
      depends_on: [],
      params: { name: 'POD Test Campaign', objective: 'MOCK_OBJECTIVE_SALES', daily_budget: null, initial_status: 'PAUSED' },
    },
    {
      action_id: 's1',
      kind: 'CREATE_ADSET_PAUSED',
      local_ref: 'adset_new',
      parent: { local_ref: 'cmp_new' },
      depends_on: ['c1'],
      params: {
        name: 'POD Test Ad set',
        daily_budget: { amount_minor: 1000, currency: 'USD' },
        lifetime_budget: null,
        optimization_goal: 'MOCK_OPT_PURCHASE',
        billing_event: 'MOCK_BILLING_IMPRESSIONS',
        audience_ref: 'aud_demo_broad',
        start_time: start,
        end_time: null,
        schedule_timezone: 'America/Los_Angeles',
        initial_status: 'PAUSED',
      },
    },
    {
      action_id: 'd1',
      kind: 'CREATE_AD_PAUSED',
      local_ref: 'ad_new',
      parent: { local_ref: 'adset_new' },
      depends_on: ['s1'],
      params: {
        name: 'POD Test Ad',
        creative_asset_id: 'asset_demo_1',
        creative_sha256: 'a'.repeat(64),
        review_id: 'review_demo_1',
        copy_variant_id: 'copy_demo_1',
        initial_status: 'PAUSED',
      },
    },
  ];
}

export const proposeInput = (actions: Action[], extra: Partial<{ source_snapshot_ids: string[]; proposal_id: string }> = {}) => ({
  ad_account_id: DEMO.ad_account_id,
  store_id: DEMO.store_id,
  actions,
  reason: 'Fixture test',
  rollback_plan: 'Đề xuất khôi phục sau kiểm tra và duyệt riêng',
  source_snapshot_ids: ['snapshot_demo'],
  ...extra,
});

/** Full happy path up to APPROVED. */
export async function proposeAndApprove(ctx: Awaited<ReturnType<typeof makeSystem>>, actions: Action[]) {
  const { sys, people } = ctx;
  const { proposal, policy } = await sys.proposals.propose(people.u_analyst!, proposeInput(actions));
  if (policy.decision !== 'pass') throw new Error(`policy blocked: ${JSON.stringify(policy.violations)}`);
  await sys.approvals.decide(people.u_approver!, proposal.proposal_id, proposal.revision, proposal.payload_hash, 'approved', null);
  return proposal;
}
