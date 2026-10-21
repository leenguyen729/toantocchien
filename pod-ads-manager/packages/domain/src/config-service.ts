import { DomainError, assertValid, isSupportedCurrency, type BusinessConfig, type ConnectionHealth, type SkillError } from '@pod/contracts';
import { isValidTimezone, missingCaps } from '@pod/policy';
import { audit, type Deps } from './context';
import { assertCan, assertTenant, type Principal } from './rbac';

export type Readiness = {
  readiness: 'ready' | 'not_ready' | 'blocked';
  missing_fields: string[];
  errors: SkillError[];
};

/** S01 deterministic validation. Never fills a missing money field with a default. */
export function assessConfig(cfg: BusinessConfig, tenantId: string): Readiness {
  const errors: SkillError[] = [];
  const err = (code: SkillError['code'], message: string) => errors.push({ code, message, retryable: false });
  if (cfg.tenant_id !== tenantId) err('TENANT_MISMATCH', 'Config thuộc tenant khác');
  for (const tz of [cfg.reporting_timezone, cfg.account_timezone]) {
    if (!isValidTimezone(tz)) err('INPUT_INVALID', `Timezone ${tz} không hợp lệ`);
  }
  for (const c of [cfg.account_currency, cfg.store_currency, ...cfg.markets.map((m) => m.currency)]) {
    if (!isSupportedCurrency(c)) err('INPUT_INVALID', `Tiền tệ ${c} chưa hỗ trợ`);
  }
  const missing = missingCaps(cfg);
  const needsFx = cfg.account_currency !== cfg.store_currency || cfg.markets.some((m) => m.currency !== cfg.account_currency);
  if (needsFx && (cfg.fx.source === null || cfg.fx.method === null)) {
    missing.push('fx.source', 'fx.method');
    err('CURRENCY_MISMATCH', 'Có nhiều tiền tệ nhưng chưa khai báo nguồn/phương pháp FX; không cộng trực tiếp các tiền tệ');
  }
  if (cfg.markets.length === 0) missing.push('markets');
  let readiness: Readiness['readiness'] = 'ready';
  if (errors.length > 0 || missing.length > 0) readiness = 'blocked';
  else if (cfg.status !== 'confirmed' || cfg.confirmed_by === null) readiness = 'not_ready';
  return { readiness, missing_fields: missing, errors };
}

export class ConfigService {
  constructor(private readonly d: Deps) {}

  async get(p: Principal, adAccountId: string): Promise<BusinessConfig | null> {
    assertCan(p, 'config.read', adAccountId);
    return this.d.store.getLatestConfig(p.tenant_id, adAccountId);
  }

  async listVersions(p: Principal, adAccountId: string): Promise<BusinessConfig[]> {
    assertCan(p, 'config.read', adAccountId);
    return this.d.store.listConfigVersions(p.tenant_id, adAccountId);
  }

  validate(p: Principal, draft: BusinessConfig): Readiness {
    assertValid<BusinessConfig>('BusinessConfig', draft);
    assertTenant(p, draft.tenant_id);
    return assessConfig(draft, p.tenant_id);
  }

  /** Saves a new immutable draft version. Confirmation is a separate, human-owner-only step. */
  async saveDraft(p: Principal, draft: BusinessConfig): Promise<{ config: BusinessConfig; assessment: Readiness }> {
    assertValid<BusinessConfig>('BusinessConfig', draft);
    assertTenant(p, draft.tenant_id);
    assertCan(p, 'config.save_draft', draft.ad_account_id);
    return this.d.store.tx(async (s) => {
      const versions = await s.listConfigVersions(p.tenant_id, draft.ad_account_id);
      const cfg: BusinessConfig = {
        ...draft,
        version: `cfg_v${versions.length + 1}`,
        status: 'draft',
        confirmed_by: null,
        confirmed_at: null,
        updated_at: this.d.clock.now().toISOString(),
      };
      await s.putConfig(cfg);
      await audit(s, this.d.clock, p, cfg.version, 'config.draft_saved', cfg, `Lưu bản nháp config ${cfg.version}`);
      return { config: cfg, assessment: assessConfig(cfg, p.tenant_id) };
    });
  }

  async confirm(p: Principal, adAccountId: string, version: string): Promise<BusinessConfig> {
    assertCan(p, 'config.confirm', adAccountId);
    return this.d.store.tx(async (s) => {
      const draft = await s.getConfigVersion(p.tenant_id, adAccountId, version);
      if (!draft) throw new DomainError('INPUT_INVALID', `Không có config version ${version}`);
      const a = assessConfig({ ...draft, status: 'confirmed', confirmed_by: p.actor_id }, p.tenant_id);
      if (a.readiness !== 'ready') {
        throw new DomainError('POLICY_BLOCKED', `Chưa thể xác nhận: thiếu ${a.missing_fields.join(', ') || a.errors.map((e) => e.code).join(', ')}`);
      }
      const versions = await s.listConfigVersions(p.tenant_id, adAccountId);
      const now = this.d.clock.now().toISOString();
      const cfg: BusinessConfig = { ...draft, version: `cfg_v${versions.length + 1}`, status: 'confirmed', confirmed_by: p.actor_id, confirmed_at: now, updated_at: now };
      await s.putConfig(cfg);
      await audit(s, this.d.clock, p, cfg.version, 'config.confirmed', cfg, `Owner xác nhận config ${cfg.version} (từ ${version})`);
      return cfg;
    });
  }

  async connectionsHealth(p: Principal): Promise<ConnectionHealth[]> {
    assertCan(p, 'ops.health');
    const at = this.d.clock.now().toISOString();
    const mode = this.d.runtime.mode;
    const meta: ConnectionHealth =
      this.d.metaRead.kind === 'mock'
        ? { connector: 'meta', mode, status: 'mock', checked_at: at, detail: 'Fake Meta adapter (mock) — không phải dữ liệu thật' }
        : { connector: 'meta', mode, status: 'not_configured', checked_at: at, detail: 'Live adapter chưa nghiệm thu' };
    return [
      meta,
      { connector: 'shopify', mode, status: mode === 'mock' ? 'mock' : 'not_configured', checked_at: at, detail: 'Shopify read-only adapter: chỉ fixture trong P1' },
      { connector: 'claude', mode, status: mode === 'mock' ? 'mock' : 'not_configured', checked_at: at, detail: 'Claude runtime: mock analyst trong P1, chưa gọi API' },
    ];
  }
}
