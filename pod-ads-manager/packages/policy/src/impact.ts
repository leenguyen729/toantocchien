import { canonicalHash, type Action, type ProposalImpact, type RemoteEntity } from '@pod/contracts';

/** Fields the worker re-reads before a mutation. Any change makes the approved before-state stale. */
export function remoteFingerprint(e: RemoteEntity): string {
  return canonicalHash({
    entity_id: e.entity_id,
    entity_type: e.entity_type,
    parent_id: e.parent_id,
    status: e.status,
    daily_budget_minor: e.daily_budget_minor,
    lifetime_budget_minor: e.lifetime_budget_minor,
    currency: e.currency,
  });
}

/**
 * Account budget totals. Conservative on purpose: PAUSED entities count too,
 * because activation is a later, cheaper step than creation and caps must
 * hold across both.
 */
export function accountTotals(remote: readonly RemoteEntity[]): { daily_minor: number; lifetime_minor: number } {
  let daily = 0;
  let lifetime = 0;
  for (const e of remote) {
    if (e.entity_type === 'ad') continue;
    daily += e.daily_budget_minor ?? 0;
    lifetime += e.lifetime_budget_minor ?? 0;
  }
  return { daily_minor: daily, lifetime_minor: lifetime };
}

/** Budget that becomes spendable when an entity goes PAUSED -> ACTIVE. */
function activationExposure(entityId: string, remote: ReadonlyMap<string, RemoteEntity>): { daily: number; lifetime: number } {
  const e = remote.get(entityId);
  if (!e) return { daily: 0, lifetime: 0 };
  if (e.entity_type === 'ad') return { daily: 0, lifetime: 0 };
  let daily = e.daily_budget_minor ?? 0;
  let lifetime = e.lifetime_budget_minor ?? 0;
  if (e.entity_type === 'campaign' && e.daily_budget_minor === null && e.lifetime_budget_minor === null) {
    for (const child of remote.values()) {
      if (child.parent_id === e.entity_id && child.entity_type === 'adset') {
        daily += child.daily_budget_minor ?? 0;
        lifetime += child.lifetime_budget_minor ?? 0;
      }
    }
  }
  return { daily, lifetime };
}

/**
 * Deterministic impact of a set of actions. exposure_minor = max new daily
 * allocation + max new lifetime allocation (including budgets unlocked by
 * activation). A platform daily budget is NOT a hard cap on real spend.
 */
export function computeImpact(
  actions: readonly Action[],
  remoteList: readonly RemoteEntity[],
  currency: string,
): ProposalImpact {
  const remote = new Map(remoteList.map((e) => [e.entity_id, e]));
  let dailyDelta = 0;
  let lifetimeDelta = 0;
  let activationDaily = 0;
  let activationLifetime = 0;
  let creates = 0;
  let activates = 0;
  for (const a of actions) {
    switch (a.kind) {
      case 'CREATE_CAMPAIGN_PAUSED':
        creates++;
        dailyDelta += a.params.daily_budget?.amount_minor ?? 0;
        break;
      case 'CREATE_ADSET_PAUSED':
        creates++;
        dailyDelta += a.params.daily_budget?.amount_minor ?? 0;
        lifetimeDelta += a.params.lifetime_budget?.amount_minor ?? 0;
        break;
      case 'CREATE_AD_PAUSED':
        creates++;
        break;
      case 'SET_DAILY_BUDGET':
        dailyDelta += a.after.amount_minor - a.before.amount_minor;
        break;
      case 'SET_LIFETIME_BUDGET':
        lifetimeDelta += a.after.amount_minor - a.before.amount_minor;
        break;
      case 'SET_STATUS':
        if (a.before.status === 'PAUSED' && a.after.status === 'ACTIVE') {
          activates++;
          const x = activationExposure(a.entity_id, remote);
          activationDaily += x.daily;
          activationLifetime += x.lifetime;
        }
        break;
    }
  }
  const totals = accountTotals(remoteList);
  return {
    currency,
    daily_budget_delta_minor: dailyDelta,
    lifetime_budget_delta_minor: lifetimeDelta,
    new_daily_budget_minor: Math.max(0, totals.daily_minor + dailyDelta),
    exposure_minor: Math.max(0, dailyDelta) + Math.max(0, lifetimeDelta) + activationDaily + activationLifetime,
    activates_entities: activates,
    creates_entities: creates,
  };
}

/** Positive allocation that must be reserved against caps while a proposal is queued/executing. */
export function reservationAmount(impact: ProposalImpact): { daily_minor: number; lifetime_minor: number } {
  return {
    daily_minor: Math.max(0, impact.daily_budget_delta_minor),
    lifetime_minor: Math.max(0, impact.lifetime_budget_delta_minor),
  };
}
