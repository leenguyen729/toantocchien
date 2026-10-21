import { describe, expect, it } from 'vitest';
import type { BusinessConfig } from '@pod/contracts';
import { assessConfig } from '@pod/domain';
import configFx from '../../fixtures/demo/business-config.json';
import { makeSystem, proposeInput, setDailyBudget } from '../helpers';

const base = configFx as BusinessConfig;

describe('S01 business context', () => {
  it('missing caps → blocked readiness, cannot be confirmed, proposals blocked', async () => {
    const ctx = await makeSystem({ confirmConfig: false, configOverrides: { caps: { daily_budget_cap_minor: null, lifetime_budget_cap_minor: 100000, proposal_exposure_cap_minor: 10000 } } });
    const { sys, people } = ctx;
    const cfg = (await sys.config.get(people.u_owner!, 'act_demo'))!;
    expect(assessConfig(cfg, cfg.tenant_id)).toMatchObject({ readiness: 'blocked', missing_fields: ['caps.daily_budget_cap_minor'] });
    await expect(sys.config.confirm(people.u_owner!, 'act_demo', cfg.version)).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    const r = await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo', 1100)]));
    expect(r.proposal.status).toBe('DRAFT');
    expect(r.proposal.caps).toBeNull();
    expect(r.policy.violations.map((v) => v.rule_id)).toEqual(expect.arrayContaining(['R_CONFIG_CONFIRMED', 'R_CAPS_PRESENT']));
  });

  it('different currencies without FX are never mixed', () => {
    const cfg = { ...base, markets: [{ country: 'US', currency: 'USD' }, { country: 'VN', currency: 'VND' }] };
    const a = assessConfig(cfg, base.tenant_id);
    expect(a.readiness).toBe('blocked');
    expect(a.errors.map((e) => e.code)).toContain('CURRENCY_MISMATCH');
    expect(assessConfig({ ...cfg, fx: { source: 'Vietcombank niêm yết', method: 'tỷ giá bán cuối ngày' } }, base.tenant_id).errors).toEqual([]);
  });

  it('invalid timezone/currency, foreign tenant, empty markets', () => {
    const a = assessConfig({ ...base, reporting_timezone: 'Not/AZone', account_currency: 'XYZ', markets: [] }, 'someone_else');
    expect(a.errors.map((e) => e.code)).toEqual(expect.arrayContaining(['TENANT_MISMATCH', 'INPUT_INVALID']));
    expect(a.missing_fields).toContain('markets');
  });

  it('confirmed config → ready; every change is a new audited version', async () => {
    const { sys, people } = await makeSystem();
    const versions = await sys.config.listVersions(people.u_owner!, 'act_demo');
    expect(versions.map((v) => [v.version, v.status])).toEqual([['cfg_v1', 'draft'], ['cfg_v2', 'confirmed']]);
    expect(assessConfig(versions[1]!, versions[1]!.tenant_id).readiness).toBe('ready');
    const audit = await sys.deps.store.listAudit(people.u_owner!.tenant_id);
    expect(audit.filter((e) => e.event_type.startsWith('config.')).map((e) => e.event_type)).toEqual(['config.draft_saved', 'config.confirmed']);
  });

  it('a newer unconfirmed draft blocks writes until the owner confirms it', async () => {
    const { sys, people } = await makeSystem();
    const cfg = (await sys.config.get(people.u_owner!, 'act_demo'))!;
    await sys.config.saveDraft(people.u_analyst!, { ...cfg, max_change_pct: 0.5 });
    const r = await sys.proposals.propose(people.u_analyst!, proposeInput([await setDailyBudget(sys, 'adset_demo', 1100)]));
    expect(r.policy.violations.map((v) => v.rule_id)).toContain('R_CONFIG_CONFIRMED');
  });

  it('only a human owner confirms; analysts may draft; inputs cannot switch tenant', async () => {
    const { sys, people } = await makeSystem();
    const cfg = (await sys.config.get(people.u_owner!, 'act_demo'))!;
    const { config } = await sys.config.saveDraft(people.u_analyst!, cfg);
    await expect(sys.config.confirm(people.u_analyst!, 'act_demo', config.version)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(sys.config.confirm(people.u_owner!, 'act_demo', 'cfg_v999')).rejects.toThrow();
    await expect(sys.config.saveDraft(people.u_analyst!, { ...cfg, tenant_id: 'tenant_other' })).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
    await expect(sys.config.saveDraft(people.u_viewer!, cfg)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(sys.config.validate(people.u_analyst!, cfg).readiness).toBe('ready');
    expect(await sys.config.connectionsHealth(people.u_analyst!)).toEqual(expect.arrayContaining([expect.objectContaining({ connector: 'meta', status: 'mock' })]));
  });
});
