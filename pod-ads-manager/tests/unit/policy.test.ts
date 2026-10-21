import { describe, expect, it } from 'vitest';
import type { Action, BusinessConfig, CreativeAsset, DataSnapshot, RemoteEntity } from '@pod/contracts';
import { POLICY_VERSION, accountTotals, computeImpact, evaluatePolicy, isValidTimezone, missingCaps, remoteFingerprint, reservationAmount, type PolicyContext, type ProposalDraft } from '@pod/policy';
import configFx from '../../fixtures/demo/business-config.json';
import entitiesFx from '../../fixtures/demo/remote-entities.json';

const NOW = new Date('2026-10-21T03:00:00Z');
const entities = entitiesFx as RemoteEntity[];
const confirmed: BusinessConfig = { ...(configFx as BusinessConfig), status: 'confirmed', confirmed_by: 'u_owner', confirmed_at: '2026-10-21T00:00:00Z', version: 'cfg_v2' };
const snapshot: DataSnapshot = {
  snapshot_id: 's1', tenant_id: 'tenant_demo', source: 'fixture', query_hash: '1'.repeat(64), api_version: 'UNVERIFIED-mock', fetched_at: '2026-10-21T02:00:00Z',
  range: null, timezone: 'UTC', currency: 'USD', attribution: null, completeness: 'complete', missing_fields: [], checksum: '2'.repeat(64),
};
const asset: CreativeAsset = { asset_id: 'as1', storage_key: 'k/a.png', sha256: 'a'.repeat(64), mime: 'image/png', width: 1, height: 1, rights_status: 'verified', rights_evidence: ['r'], product_refs: [], review_id: 'rv1', version: 1 };

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    now: NOW,
    config: confirmed,
    liveWritesEnabled: false,
    accountAllowlist: [],
    frozen: false,
    remote: entities,
    verifiedEntityIds: new Set(),
    reserved: { daily_minor: 0, lifetime_minor: 0 },
    snapshots: new Map([['s1', snapshot]]),
    lastChangedAt: new Map(),
    reviews: new Map([['rv1', { review_id: 'rv1', decision: 'pass', reviewed_sha256: 'a'.repeat(64), policy_version: POLICY_VERSION, human_reviewed: true }]]),
    assets: new Map([['as1', asset]]),
    capabilities: { snapshot_id: 'cap', verified: true, source: 'mock_fixture', objectives: ['OBJ'], optimization_goals: ['OPT'], billing_events: ['BILL'] },
    ...over,
  };
}

const ent = (id: string) => entities.find((e) => e.entity_id === id)!;
function budget(id: string, after: number, actionId = 'a1', kind: 'SET_DAILY_BUDGET' | 'SET_LIFETIME_BUDGET' = 'SET_DAILY_BUDGET', currency = 'USD'): Action {
  const e = ent(id);
  const before = kind === 'SET_DAILY_BUDGET' ? (e.daily_budget_minor ?? 0) : (e.lifetime_budget_minor ?? 0);
  return { action_id: actionId, kind, entity_type: 'adset', entity_id: id, before: { amount_minor: before, currency }, after: { amount_minor: after, currency }, depends_on: [], preconditions: { status: e.status, remote_fingerprint: remoteFingerprint(e) } } as Action;
}
function statusAction(id: string, to: 'ACTIVE' | 'PAUSED', actionId = 'st1'): Action {
  const e = ent(id);
  return { action_id: actionId, kind: 'SET_STATUS', entity_type: e.entity_type, entity_id: id, before: { status: e.status }, after: { status: to }, depends_on: [], preconditions: { status: e.status, remote_fingerprint: remoteFingerprint(e) } };
}
const campaign = (over: Record<string, unknown> = {}): Action => ({ action_id: 'c1', kind: 'CREATE_CAMPAIGN_PAUSED', local_ref: 'cmp', depends_on: [], params: { name: 'C', objective: 'OBJ', daily_budget: null, initial_status: 'PAUSED' }, ...over }) as Action;
const adset = (over: Record<string, unknown> = {}, params: Record<string, unknown> = {}): Action =>
  ({
    action_id: 's1', kind: 'CREATE_ADSET_PAUSED', local_ref: 'set', parent: { local_ref: 'cmp' }, depends_on: ['c1'],
    params: { name: 'S', daily_budget: { amount_minor: 1000, currency: 'USD' }, lifetime_budget: null, optimization_goal: 'OPT', billing_event: 'BILL', audience_ref: 'aud', start_time: '2026-10-22T00:00:00Z', end_time: null, schedule_timezone: 'America/New_York', initial_status: 'PAUSED', ...params },
    ...over,
  }) as Action;
const ad = (over: Record<string, unknown> = {}, params: Record<string, unknown> = {}): Action =>
  ({ action_id: 'd1', kind: 'CREATE_AD_PAUSED', local_ref: 'ad', parent: { local_ref: 'set' }, depends_on: ['s1'], params: { name: 'A', creative_asset_id: 'as1', creative_sha256: 'a'.repeat(64), review_id: 'rv1', copy_variant_id: 'cv', initial_status: 'PAUSED', ...params }, ...over }) as Action;

const draft = (actions: Action[], over: Partial<ProposalDraft> = {}): ProposalDraft => ({ tenant_id: 'tenant_demo', ad_account_id: 'act_demo', mode: 'mock', expires_at: '2026-10-21T03:30:00Z', source_snapshot_ids: ['s1'], actions, ...over });
const rules = (d: ProposalDraft, c = ctx()) => evaluatePolicy(d, c).violations.map((v) => v.rule_id);

describe('policy engine — pass cases', () => {
  it('passes a valid +10% budget change with a spend-cap warning', () => {
    const r = evaluatePolicy(draft([budget('adset_demo', 1100)]), ctx());
    expect(r.decision).toBe('pass');
    expect(r.warnings.join(' ')).toMatch(/không phải trần chi tiêu/);
  });
  it('passes a full PAUSED hierarchy', () => {
    expect(rules(draft([campaign(), adset(), ad()]))).toEqual([]);
  });
  it('passes a decrease without warnings', () => {
    const r = evaluatePolicy(draft([budget('adset_demo', 900)]), ctx());
    expect(r.decision).toBe('pass');
    expect(r.warnings).toEqual([]);
  });
});

describe('policy engine — mode, freeze, config', () => {
  it('read_only and approval-without-flag/allowlist are blocked', () => {
    expect(rules(draft([budget('adset_demo', 1100)], { mode: 'read_only' }))).toContain('R_MODE_READ_ONLY');
    expect(rules(draft([budget('adset_demo', 1100)], { mode: 'approval' }))).toEqual(expect.arrayContaining(['R_MODE_LIVE_FLAG', 'R_MODE_ALLOWLIST']));
    expect(rules(draft([budget('adset_demo', 1100)], { mode: 'approval' }), ctx({ liveWritesEnabled: true, accountAllowlist: ['act_demo'] }))).toEqual([]);
  });
  it('kill switch blocks', () => expect(rules(draft([budget('adset_demo', 1100)]), ctx({ frozen: true }))).toContain('R_FREEZE'));
  it('missing / unconfirmed / foreign config blocks', () => {
    expect(rules(draft([budget('adset_demo', 1100)]), ctx({ config: null }))).toContain('R_CONFIG_MISSING');
    expect(rules(draft([budget('adset_demo', 1100)]), ctx({ config: { ...confirmed, status: 'draft' } }))).toContain('R_CONFIG_CONFIRMED');
    expect(rules(draft([budget('adset_demo', 1100)], { tenant_id: 'other' }))).toContain('R_TENANT_ACCOUNT');
  });
  it('missing caps are a blocker; demo numbers are never substituted', () => {
    const cfg = { ...confirmed, caps: { ...confirmed.caps, daily_budget_cap_minor: null }, cooldown_seconds: null };
    const v = evaluatePolicy(draft([budget('adset_demo', 1100)]), ctx({ config: cfg }));
    expect(v.violations.map((x) => x.rule_id)).toContain('R_CAPS_PRESENT');
    expect(v.violations.find((x) => x.rule_id === 'R_CAPS_PRESENT')!.message).toMatch(/daily_budget_cap_minor/);
    expect(missingCaps({ ...confirmed, caps: { daily_budget_cap_minor: null, lifetime_budget_cap_minor: null, proposal_exposure_cap_minor: null }, max_change_pct: null, max_change_amount_minor: null, freshness_seconds: null, cooldown_seconds: null, approval_ttl_seconds: null })).toHaveLength(8);
  });
  it('multi-currency without FX source blocks; with FX passes that rule', () => {
    const cfg = { ...confirmed, store_currency: 'EUR' };
    expect(rules(draft([budget('adset_demo', 1100)]), ctx({ config: cfg }))).toContain('R_FX');
    expect(rules(draft([budget('adset_demo', 1100)]), ctx({ config: { ...cfg, fx: { source: 'ECB reference', method: 'daily close' } } }))).not.toContain('R_FX');
  });
  it('expired TTL blocks', () => expect(rules(draft([budget('adset_demo', 1100)], { expires_at: '2026-10-21T02:59:59Z' }))).toContain('R_TTL'));
});

describe('policy engine — data quality', () => {
  it('requires at least one known, complete, fresh snapshot', () => {
    expect(rules(draft([budget('adset_demo', 1100)], { source_snapshot_ids: [] }))).toContain('R_FRESHNESS_SOURCE');
    expect(rules(draft([budget('adset_demo', 1100)], { source_snapshot_ids: ['nope'] }))).toContain('R_FRESHNESS_SOURCE');
    expect(rules(draft([budget('adset_demo', 1100)]), ctx({ snapshots: new Map([['s1', { ...snapshot, completeness: 'incomplete' }]]) }))).toContain('R_COMPLETENESS');
    expect(rules(draft([budget('adset_demo', 1100)]), ctx({ snapshots: new Map([['s1', { ...snapshot, fetched_at: '2026-10-20T00:00:00Z' }]]) }))).toContain('R_FRESHNESS');
    expect(rules(draft([budget('adset_demo', 1100)]), ctx({ snapshots: new Map([['s1', { ...snapshot, tenant_id: 'other' }]]) }))).toContain('R_FRESHNESS_SOURCE');
  });
});

describe('policy engine — money', () => {
  it('currency mismatch on any money field blocks', () => {
    expect(rules(draft([budget('adset_demo', 1100, 'a1', 'SET_DAILY_BUDGET', 'EUR')]))).toContain('R_CURRENCY');
  });
  it('enforces absolute and percentage change limits', () => {
    expect(rules(draft([budget('adset_demo', 1300)]))).toContain('R_CHANGE_PCT'); // +30% > 20%
    const big = { ...confirmed, max_change_pct: 10, caps: { ...confirmed.caps, proposal_exposure_cap_minor: 1_000_000, daily_budget_cap_minor: 1_000_000 } };
    expect(rules(draft([budget('adset_demo', 5000)]), ctx({ config: big }))).toContain('R_CHANGE_AMOUNT');
  });
  it('treats change from zero as exceeding percentage limit', () => {
    const zero = entities.map((e) => (e.entity_id === 'adset_demo' ? { ...e, daily_budget_minor: 0 } : e));
    const e = zero.find((x) => x.entity_id === 'adset_demo')!;
    const a: Action = { action_id: 'a1', kind: 'SET_DAILY_BUDGET', entity_type: 'adset', entity_id: 'adset_demo', before: { amount_minor: 0, currency: 'USD' }, after: { amount_minor: 100, currency: 'USD' }, depends_on: [], preconditions: { status: 'PAUSED', remote_fingerprint: remoteFingerprint(e) } };
    expect(rules(draft([a]), ctx({ remote: zero }))).toContain('R_CHANGE_PCT');
  });
  it('no-op changes are rejected', () => {
    expect(rules(draft([budget('adset_demo', 1000)]))).toContain('R_NOOP');
    expect(rules(draft([{ ...statusAction('adset_demo', 'PAUSED') }]))).toContain('R_NOOP');
  });
  it('daily cap includes current totals and other reservations', () => {
    // totals: 1000 + 1500 = 2500. cap 20000.
    expect(rules(draft([budget('adset_demo', 1100)]), ctx({ reserved: { daily_minor: 17_401, lifetime_minor: 0 } }))).toContain('R_DAILY_CAP');
    expect(rules(draft([budget('adset_demo', 1100)]), ctx({ reserved: { daily_minor: 17_400, lifetime_minor: 0 } }))).not.toContain('R_DAILY_CAP');
  });
  it('lifetime cap and exposure cap', () => {
    const lifetimeSet = adset({}, { daily_budget: null, lifetime_budget: { amount_minor: 100_001, currency: 'USD' }, end_time: '2026-11-01T00:00:00Z' });
    expect(rules(draft([campaign(), lifetimeSet]))).toEqual(expect.arrayContaining(['R_LIFETIME_CAP', 'R_EXPOSURE_CAP']));
    expect(rules(draft([budget('adset_demo', 1100)]), ctx({ reserved: { daily_minor: 0, lifetime_minor: 100_001 } }))).toContain('R_LIFETIME_CAP');
  });
  it('lifetime budget change on an adset', () => {
    const withLifetime = entities.map((e) => (e.entity_id === 'adset_demo' ? { ...e, daily_budget_minor: null, lifetime_budget_minor: 10_000 } : e));
    const e = withLifetime.find((x) => x.entity_id === 'adset_demo')!;
    const a: Action = { action_id: 'a1', kind: 'SET_LIFETIME_BUDGET', entity_type: 'adset', entity_id: 'adset_demo', before: { amount_minor: 10_000, currency: 'USD' }, after: { amount_minor: 11_000, currency: 'USD' }, depends_on: [], preconditions: { status: 'PAUSED', remote_fingerprint: remoteFingerprint(e) } };
    expect(rules(draft([a]), ctx({ remote: withLifetime }))).toEqual([]);
    const wrongKind = { ...a, kind: 'SET_DAILY_BUDGET' } as Action;
    expect(rules(draft([wrongKind]), ctx({ remote: withLifetime }))).toEqual(expect.arrayContaining(['R_BEFORE_MATCH', 'R_BUDGET_KIND']));
  });
});

describe('policy engine — remote state and cooldown', () => {
  it('detects missing entity, fingerprint drift and before mismatch', () => {
    const missing = { ...budget('adset_demo', 1100), entity_id: 'ghost' } as Action;
    expect(rules(draft([missing]))).toContain('R_ENTITY_EXISTS');
    const drifted = entities.map((e) => (e.entity_id === 'adset_demo' ? { ...e, daily_budget_minor: 1050 } : e));
    expect(rules(draft([budget('adset_demo', 1100)]), ctx({ remote: drifted }))).toEqual(expect.arrayContaining(['R_BEFORE_FINGERPRINT', 'R_BEFORE_MATCH']));
    const wrongStatus = { ...statusAction('adset_demo', 'ACTIVE'), before: { status: 'ACTIVE' } } as Action;
    expect(rules(draft([wrongStatus]))).toContain('R_BEFORE_MATCH');
  });
  it('cooldown blocks recently changed entities', () => {
    expect(rules(draft([budget('adset_demo', 1100)]), ctx({ lastChangedAt: new Map([['adset_demo', new Date('2026-10-20T12:00:00Z')]]) }))).toContain('R_COOLDOWN');
    expect(rules(draft([budget('adset_demo', 1100)]), ctx({ lastChangedAt: new Map([['adset_demo', new Date('2026-10-19T00:00:00Z')]]) }))).not.toContain('R_COOLDOWN');
  });
});

describe('policy engine — activation', () => {
  it('activation must be separate from creates and target a remote-verified entity', () => {
    expect(rules(draft([campaign(), statusAction('cmp_demo_1', 'ACTIVE')]))).toEqual(expect.arrayContaining(['R_ACTIVATION_SEPARATE', 'R_ACTIVATION_VERIFIED']));
    expect(rules(draft([statusAction('cmp_demo_1', 'ACTIVE')]), ctx({ verifiedEntityIds: new Set(['cmp_demo_1']) }))).toEqual([]);
  });
  it('activation exposure counts child adset budgets of a CBO-less campaign', () => {
    const impact = computeImpact([statusAction('cmp_demo_1', 'ACTIVE')], entities, 'USD');
    expect(impact.exposure_minor).toBe(2500);
    expect(impact.activates_entities).toBe(1);
    expect(computeImpact([statusAction('adset_demo', 'ACTIVE')], entities, 'USD').exposure_minor).toBe(1000);
  });
  it('pausing has no exposure', () => {
    const active = entities.map((e) => ({ ...e, status: 'ACTIVE' as const }));
    const e = active.find((x) => x.entity_id === 'adset_demo')!;
    const pause: Action = { action_id: 'p', kind: 'SET_STATUS', entity_type: 'adset', entity_id: 'adset_demo', before: { status: 'ACTIVE' }, after: { status: 'PAUSED' }, depends_on: [], preconditions: { status: 'ACTIVE', remote_fingerprint: remoteFingerprint(e) } };
    expect(computeImpact([pause], active, 'USD').exposure_minor).toBe(0);
    expect(rules(draft([pause]), ctx({ remote: active }))).toEqual([]);
  });
});

describe('policy engine — graph and schedule', () => {
  it('duplicate ids, bad dependency order and wrong parents', () => {
    expect(rules(draft([campaign(), campaign()]))).toEqual(expect.arrayContaining(['R_DAG_UNIQUE', 'R_DAG_LOCAL_REF']));
    expect(rules(draft([adset(), campaign()]))).toContain('R_DAG_ORDER');
    expect(rules(draft([campaign(), adset({ parent: { local_ref: 'nope' } })]))).toContain('R_DAG_PARENT');
    expect(rules(draft([campaign(), adset({ depends_on: [] })]))).toContain('R_DAG_PARENT_DEP');
    expect(rules(draft([adset({ parent: { entity_id: 'ghost' }, depends_on: [] })]))).toContain('R_DAG_PARENT_REMOTE');
    expect(rules(draft([ad({ parent: { entity_id: 'cmp_demo_1' }, depends_on: [] })]))).toContain('R_DAG_PARENT_REMOTE');
    expect(rules(draft([ad({ parent: { entity_id: 'adset_demo' }, depends_on: [] })]))).toEqual([]);
  });
  it('budget level: no adset budget under a budgeted campaign; not both kinds', () => {
    const cbo = campaign({ params: { name: 'C', objective: 'OBJ', daily_budget: { amount_minor: 500, currency: 'USD' }, initial_status: 'PAUSED' } });
    expect(rules(draft([cbo, adset()]))).toContain('R_BUDGET_LEVEL');
    expect(rules(draft([campaign(), adset({}, { lifetime_budget: { amount_minor: 1, currency: 'USD' }, end_time: '2026-11-01T00:00:00Z' })]))).toContain('R_BUDGET_ONE_KIND');
    const remoteCbo = entities.map((e) => (e.entity_id === 'cmp_demo_1' ? { ...e, daily_budget_minor: 100 } : e));
    expect(rules(draft([adset({ parent: { entity_id: 'cmp_demo_1' }, depends_on: [] })]), ctx({ remote: remoteCbo }))).toContain('R_BUDGET_LEVEL');
  });
  it('schedule: timezone, past start, ordering, lifetime needs end', () => {
    expect(rules(draft([campaign(), adset({}, { schedule_timezone: 'Mars/Olympus' })]))).toContain('R_SCHEDULE_TZ');
    expect(rules(draft([campaign(), adset({}, { start_time: '2026-10-20T00:00:00Z' })]))).toContain('R_SCHEDULE_PAST');
    expect(rules(draft([campaign(), adset({}, { end_time: '2026-10-21T23:00:00Z' })]))).toContain('R_SCHEDULE_ORDER');
    expect(rules(draft([campaign(), adset({}, { daily_budget: null, lifetime_budget: { amount_minor: 100, currency: 'USD' } })]))).toContain('R_SCHEDULE_LIFETIME_END');
    expect(isValidTimezone('Asia/Ho_Chi_Minh')).toBe(true);
  });
  it('DST-crossing schedules are judged on UTC instants, not wall clock', () => {
    // 2026-11-01 is the US DST end. Start 01:30 local (EDT) and end 01:15 local (EST) is still later in UTC.
    const a = adset({}, { start_time: '2026-11-01T05:30:00Z', end_time: '2026-11-01T06:15:00Z' });
    expect(rules(draft([campaign(), a]))).toEqual([]);
  });
});

describe('policy engine — capability and creative review', () => {
  it('unverified capability snapshot or unknown enums block creates', () => {
    expect(rules(draft([campaign()]), ctx({ capabilities: null }))).toContain('R_CAPABILITY');
    expect(rules(draft([campaign()]), ctx({ capabilities: { ...ctx().capabilities!, verified: false } }))).toContain('R_CAPABILITY');
    expect(rules(draft([campaign({ params: { name: 'C', objective: 'OUTCOME_GUESS', daily_budget: null, initial_status: 'PAUSED' } })]))).toContain('R_CAPABILITY');
    expect(rules(draft([campaign(), adset({}, { optimization_goal: 'GUESS' })]))).toContain('R_CAPABILITY');
  });
  it('changed asset hash, missing rights or stale review blocks', () => {
    expect(rules(draft([campaign(), adset(), ad({}, { creative_sha256: 'b'.repeat(64) })]))).toEqual(expect.arrayContaining(['R_ASSET_HASH', 'R_REVIEW_STALE']));
    expect(rules(draft([campaign(), adset(), ad()]), ctx({ assets: new Map([['as1', { ...asset, rights_status: 'pending' }]]) }))).toContain('R_ASSET_RIGHTS');
    expect(rules(draft([campaign(), adset(), ad()]), ctx({ reviews: new Map() }))).toContain('R_REVIEW_STALE');
    const rv = ctx().reviews.get('rv1')!;
    expect(rules(draft([campaign(), adset(), ad()]), ctx({ reviews: new Map([['rv1', { ...rv, policy_version: 'old' }]]) }))).toContain('R_REVIEW_POLICY_VERSION');
    expect(rules(draft([campaign(), adset(), ad()]), ctx({ reviews: new Map([['rv1', { ...rv, decision: 'block' }]]) }))).toContain('R_REVIEW_DECISION');
    expect(rules(draft([campaign(), adset(), ad()]), ctx({ reviews: new Map([['rv1', { ...rv, decision: 'warn', human_reviewed: false }]]) }))).toContain('R_REVIEW_DECISION');
    expect(rules(draft([campaign(), adset(), ad()]), ctx({ reviews: new Map([['rv1', { ...rv, decision: 'warn', human_reviewed: true }]]) }))).toEqual([]);
  });
});

describe('impact helpers', () => {
  it('totals ignore ads and count paused budgets', () => {
    expect(accountTotals(entities)).toEqual({ daily_minor: 2500, lifetime_minor: 0 });
  });
  it('creates add exposure; decreases do not offset reservations below zero', () => {
    const i = computeImpact([campaign(), adset(), ad()], entities, 'USD');
    expect(i).toMatchObject({ daily_budget_delta_minor: 1000, creates_entities: 3, exposure_minor: 1000, new_daily_budget_minor: 3500 });
    const dec = computeImpact([budget('adset_demo', 900)], entities, 'USD');
    expect(dec.exposure_minor).toBe(0);
    expect(reservationAmount(dec)).toEqual({ daily_minor: 0, lifetime_minor: 0 });
    const cbo = campaign({ params: { name: 'C', objective: 'OBJ', daily_budget: { amount_minor: 700, currency: 'USD' }, initial_status: 'PAUSED' } });
    expect(computeImpact([cbo], entities, 'USD').daily_budget_delta_minor).toBe(700);
    const ghost = { ...statusAction('adset_demo', 'ACTIVE'), entity_id: 'ghost' } as Action;
    expect(computeImpact([ghost], entities, 'USD').exposure_minor).toBe(0);
    const adActivation = { ...statusAction('adset_demo', 'ACTIVE'), entity_type: 'ad', entity_id: 'ad_x' } as Action;
    expect(computeImpact([adActivation], [...entities, { ...ent('adset_demo'), entity_id: 'ad_x', entity_type: 'ad' }], 'USD').exposure_minor).toBe(0);
  });
});
