import type { BusinessConfig, DataSnapshot, RemoteEntity } from '@pod/contracts';
import tenantFx from '../../../fixtures/demo/tenant.json';
import configFx from '../../../fixtures/demo/business-config.json';
import entitiesFx from '../../../fixtures/demo/remote-entities.json';
import snapshotsFx from '../../../fixtures/demo/snapshots.json';
import creativeFx from '../../../fixtures/demo/creative.json';
import type { Principal } from './rbac';
import type { System } from './system';
import type { AssetRecord, ReviewRecord } from './store/types';

export const DEMO = {
  tenant_id: tenantFx.tenant_id,
  store_id: tenantFx.store_id,
  ad_account_id: tenantFx.ad_account_id,
  other_tenant_id: tenantFx.other_tenant.tenant_id,
  other_ad_account_id: tenantFx.other_tenant.ad_account_id,
} as const;

export function demoPrincipals(): Record<string, Principal> {
  const out: Record<string, Principal> = {};
  for (const u of tenantFx.users) out[u.actor_id] = { ...(u as Omit<Principal, 'tenant_id'>), tenant_id: tenantFx.tenant_id };
  for (const u of tenantFx.other_tenant.users) out[u.actor_id] = { ...(u as Omit<Principal, 'tenant_id'>), tenant_id: tenantFx.other_tenant.tenant_id };
  return out;
}

export type SeedOptions = { confirmConfig?: boolean; configOverrides?: Partial<BusinessConfig> };

/**
 * Load fixtures into a mock-mode system. Config goes through the real
 * draft → owner-confirm path so it is versioned and audited like production.
 */
export async function seedDemo(sys: System, opts: SeedOptions = {}): Promise<Record<string, Principal>> {
  if (!sys.fakeMeta) throw new Error('seedDemo chỉ chạy ở mock mode');
  const people = demoPrincipals();
  const now = sys.deps.clock.now();
  sys.fakeMeta.seed(DEMO.ad_account_id, entitiesFx as RemoteEntity[]);
  sys.fakeMeta.seed(
    DEMO.other_ad_account_id,
    (entitiesFx as RemoteEntity[]).map((e) => ({ ...e, entity_id: `${e.entity_id}_other`, parent_id: e.parent_id ? `${e.parent_id}_other` : null })),
  );
  const fresh = new Date(now.getTime() - 3600_000).toISOString();
  for (const s of snapshotsFx as DataSnapshot[]) await sys.deps.store.putSnapshot({ ...s, fetched_at: fresh });
  for (const a of creativeFx.assets as AssetRecord[]) await sys.deps.store.putAsset(a);
  for (const r of creativeFx.reviews as ReviewRecord[]) await sys.deps.store.putReview(r);

  const owner = people.u_owner!;
  const draft = { ...(configFx as BusinessConfig), ...opts.configOverrides, updated_at: now.toISOString() };
  const { config } = await sys.config.saveDraft(owner, draft);
  if (opts.confirmConfig !== false) await sys.config.confirm(owner, DEMO.ad_account_id, config.version);
  return people;
}
