import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { SCHEMA_NAMES, SKILL_PAYLOAD_SCHEMAS, SKILL_SLUGS, schemaBundle, validate } from '@pod/contracts';
import configFx from '../../fixtures/demo/business-config.json';
import entitiesFx from '../../fixtures/demo/remote-entities.json';
import snapshotsFx from '../../fixtures/demo/snapshots.json';
import creativeFx from '../../fixtures/demo/creative.json';

const defs = schemaBundle.$defs as Record<string, { type?: string; additionalProperties?: unknown; oneOf?: unknown }>;
const fp = 'f'.repeat(64);
const setBudget = { action_id: 'a1', kind: 'SET_DAILY_BUDGET', entity_type: 'adset', entity_id: 'adset_demo', before: { amount_minor: 1000, currency: 'USD' }, after: { amount_minor: 1100, currency: 'USD' }, depends_on: [], preconditions: { status: 'PAUSED', remote_fingerprint: fp } };

describe('schema bundle', () => {
  it('is Draft 2020-12 and every object schema is closed', () => {
    expect(schemaBundle.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    const walk = (node: unknown, path: string): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      if (n.type === 'object' && n.properties && !n.oneOf) expect(n.additionalProperties, path).toBe(false);
      for (const [k, v] of Object.entries(n)) walk(v, `${path}/${k}`);
    };
    walk(defs, '#');
  });
  it('has exactly 18 skills, each with input and output payload schemas', () => {
    expect(SKILL_SLUGS).toHaveLength(18);
    expect(new Set(SKILL_SLUGS).size).toBe(18);
    for (const slug of SKILL_SLUGS) {
      const m = SKILL_PAYLOAD_SCHEMAS[slug];
      expect(SCHEMA_NAMES, slug).toContain(m.input);
      expect(SCHEMA_NAMES, slug).toContain(m.output);
    }
  });
  it('every skill payload rejects unknown fields before any side effect', () => {
    for (const slug of SKILL_SLUGS) {
      const { input } = SKILL_PAYLOAD_SCHEMAS[slug];
      const r = validate(input, { __unknown_field__: 1 });
      expect(r.ok, input).toBe(false);
    }
  });
  it('generated JSON/TS are up to date', () => {
    execFileSync('npx', ['tsx', 'scripts/gen-schemas.ts', '--check'], { stdio: 'pipe' });
  });
});

describe('fixtures conform to contracts', () => {
  it('business config, entities, snapshots, assets', () => {
    expect(validate('BusinessConfig', configFx)).toEqual({ ok: true });
    for (const e of entitiesFx) expect(validate('RemoteEntity', e)).toEqual({ ok: true });
    for (const s of snapshotsFx) expect(validate('DataSnapshot', s)).toEqual({ ok: true });
    for (const { tenant_id: _t, ...a } of creativeFx.assets) expect(validate('CreativeAsset', a)).toEqual({ ok: true });
  });
});

describe('action allowlist', () => {
  it('accepts allowlisted kinds', () => expect(validate('Action', setBudget)).toEqual({ ok: true }));
  it('rejects delete and unknown kinds', () => {
    expect(validate('Action', { ...setBudget, kind: 'DELETE_CAMPAIGN' }).ok).toBe(false);
    expect(validate('Action', { ...setBudget, kind: 'RAW_HTTP' }).ok).toBe(false);
  });
  it('creates are PAUSED by construction', () => {
    const c = { action_id: 'c1', kind: 'CREATE_CAMPAIGN_PAUSED', local_ref: 'x', depends_on: [], params: { name: 'n', objective: 'o', daily_budget: null, initial_status: 'ACTIVE' } };
    expect(validate('Action', c).ok).toBe(false);
    expect(validate('Action', { ...c, params: { ...c.params, initial_status: 'PAUSED' } }).ok).toBe(true);
  });
  it('rejects unknown fields, floats, bad currency, bad ids', () => {
    expect(validate('Action', { ...setBudget, tenant_id: 'other' }).ok).toBe(false);
    expect(validate('Action', { ...setBudget, after: { amount_minor: 11.5, currency: 'USD' } }).ok).toBe(false);
    expect(validate('Action', { ...setBudget, after: { amount_minor: -1, currency: 'USD' } }).ok).toBe(false);
    expect(validate('Action', { ...setBudget, after: { amount_minor: 1100, currency: 'usd' } }).ok).toBe(false);
    expect(validate('Action', { ...setBudget, entity_id: '../etc/passwd' }).ok).toBe(false);
    expect(validate('Action', { ...setBudget, entity_id: '' }).ok).toBe(false);
    expect(validate('Action', { ...setBudget, preconditions: { status: 'PAUSED', remote_fingerprint: 'fixture' } }).ok).toBe(false);
  });
  it('unknown-field errors name the field, never the value', () => {
    const r = validate('Action', { ...setBudget, secret_token: 'EAAB-should-not-echo' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(JSON.stringify(r.issues)).toContain('secret_token');
      expect(JSON.stringify(r.issues)).not.toContain('EAAB-should-not-echo');
    }
  });
});

describe('timestamps, timezones, enums', () => {
  const env = { schema_version: '1.0', run_id: 'r1', tenant_id: 't', store_id: 's', ad_account_id: 'a', requested_at: '2026-10-21T03:00:00Z', mode: 'mock', config_version: 'v1', payload: {} };
  it('envelope requires UTC RFC3339 and known mode', () => {
    expect(validate('SkillInputEnvelope', env)).toEqual({ ok: true });
    expect(validate('SkillInputEnvelope', { ...env, requested_at: '2026-10-21T10:00:00+07:00' }).ok).toBe(false);
    expect(validate('SkillInputEnvelope', { ...env, requested_at: '21/10/2026' }).ok).toBe(false);
    expect(validate('SkillInputEnvelope', { ...env, mode: 'live' }).ok).toBe(false);
    expect(validate('SkillInputEnvelope', { ...env, schema_version: '2.0' }).ok).toBe(false);
  });
  it('error codes are the standard list', () => {
    expect(validate('SkillError', { code: 'WRITE_FROZEN', message: 'x', retryable: false })).toEqual({ ok: true });
    expect(validate('SkillError', { code: 'OOPS', message: 'x', retryable: false }).ok).toBe(false);
  });
  it('freeze state can never claim to stop running ads', () => {
    expect(validate('FreezeState', { frozen: true, reason: null, changed_by: null, changed_at: null, stops_running_ads: true }).ok).toBe(false);
  });
});

describe('S17 input is a closed discriminated union', () => {
  it('execution.request takes only id/revision/hash — no raw actions', () => {
    expect(validate('ApprovalExecutionInput', { operation: 'request_execution', proposal_id: 'p', revision: 1, expected_payload_hash: fp }).ok).toBe(true);
    expect(validate('ApprovalExecutionInput', { operation: 'request_execution', proposal_id: 'p', revision: 1, expected_payload_hash: fp, actions: [setBudget] }).ok).toBe(false);
    expect(validate('ApprovalExecutionInput', { operation: 'approve', proposal_id: 'p', revision: 1 }).ok).toBe(false);
  });
});
