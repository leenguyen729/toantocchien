import type { Action, RemoteEntity } from '@pod/contracts';
import type { CapabilitySnapshot, CreativeReview, PolicyContext } from '@pod/policy';
import type { Deps } from './context';
import type { Store } from './store/types';

/**
 * Assemble everything the deterministic policy needs from authoritative
 * sources: stored config, remote readback, reservations, registries. Nothing
 * here comes from model output.
 */
export async function buildPolicyContext(
  d: Deps,
  s: Store,
  tenantId: string,
  adAccountId: string,
  actions: readonly Action[],
  sourceSnapshotIds: readonly string[],
  excludeReservation?: { proposal_id: string; revision: number },
  remoteOverride?: RemoteEntity[],
): Promise<PolicyContext> {
  const config = await s.getLatestConfig(tenantId, adAccountId);
  const remote = remoteOverride ?? (await d.metaRead.listEntities(adAccountId));
  const caps = await d.metaRead.capabilities(adAccountId);
  const reviewIds: string[] = [];
  const assetIds: string[] = [];
  for (const a of actions) {
    if (a.kind === 'CREATE_AD_PAUSED') {
      reviewIds.push(a.params.review_id);
      assetIds.push(a.params.creative_asset_id);
    }
  }
  const [freeze, reserved, snapshots, reviews, assets, changes, verified] = await Promise.all([
    s.getFreeze(tenantId),
    s.sumActiveReservations(tenantId, adAccountId, excludeReservation),
    s.getSnapshots(tenantId, [...sourceSnapshotIds]),
    s.getReviews(tenantId, reviewIds),
    s.getAssets(tenantId, assetIds),
    s.lastEntityChanges(tenantId, adAccountId),
    s.listVerifiedEntities(tenantId, adAccountId),
  ]);
  const capabilities: CapabilitySnapshot = {
    snapshot_id: caps.snapshot_id,
    verified: caps.verified && (caps.source !== 'mock_fixture' || d.runtime.mode === 'mock'),
    source: caps.source,
    objectives: caps.objectives,
    optimization_goals: caps.optimization_goals,
    billing_events: caps.billing_events,
  };
  return {
    now: d.clock.now(),
    // Latest version wins even if it is an unconfirmed draft: pending config edits block writes (fail closed).
    config,
    liveWritesEnabled: d.runtime.liveWritesEnabled,
    accountAllowlist: d.runtime.accountAllowlist,
    frozen: freeze.frozen,
    remote,
    verifiedEntityIds: verified,
    reserved,
    snapshots: new Map(snapshots.map((x) => [x.snapshot_id, x])),
    lastChangedAt: new Map([...changes.entries()].map(([k, v]) => [k, new Date(v)])),
    reviews: new Map<string, CreativeReview>(reviews.map((r) => [r.review_id, r])),
    assets: new Map(assets.map((a) => [a.asset_id, a])),
    capabilities,
  };
}
