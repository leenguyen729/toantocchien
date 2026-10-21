import Decimal from 'decimal.js';
import type {
  Action,
  BusinessConfig,
  CreativeAsset,
  DataSnapshot,
  ErrorCode,
  Mode,
  PolicyResult,
  PolicyViolation,
  RemoteEntity,
} from '@pod/contracts';
import { accountTotals, computeImpact, remoteFingerprint } from './impact';

export const POLICY_VERSION = 'policy_v1.0';

export type CreativeReview = {
  review_id: string;
  decision: 'pass' | 'warn' | 'block';
  reviewed_sha256: string;
  policy_version: string;
  human_reviewed: boolean;
};

/** Platform enums verified for this account. `null` = not verified → fail closed. */
export type CapabilitySnapshot = {
  snapshot_id: string;
  verified: boolean;
  source: 'mock_fixture' | 'official_docs' | 'account_probe';
  objectives: string[];
  optimization_goals: string[];
  billing_events: string[];
};

export type ProposalDraft = {
  tenant_id: string;
  ad_account_id: string;
  mode: Mode;
  expires_at: string;
  source_snapshot_ids: string[];
  actions: Action[];
};

export type PolicyContext = {
  now: Date;
  config: BusinessConfig | null;
  liveWritesEnabled: boolean;
  accountAllowlist: readonly string[];
  frozen: boolean;
  remote: readonly RemoteEntity[];
  /** Entities created by this system and confirmed by remote readback. */
  verifiedEntityIds: ReadonlySet<string>;
  /** Other proposals' active reservations in this account scope. */
  reserved: { daily_minor: number; lifetime_minor: number };
  snapshots: ReadonlyMap<string, DataSnapshot>;
  lastChangedAt: ReadonlyMap<string, Date>;
  reviews: ReadonlyMap<string, CreativeReview>;
  assets: ReadonlyMap<string, CreativeAsset>;
  capabilities: CapabilitySnapshot | null;
};

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

class Collector {
  readonly violations: PolicyViolation[] = [];
  readonly warnings: string[] = [];
  block(rule_id: string, code: ErrorCode, message: string, action_id: string | null = null): void {
    this.violations.push({ rule_id, code, message, action_id });
  }
}

function moneyOf(a: Action): { currency: string }[] {
  switch (a.kind) {
    case 'CREATE_CAMPAIGN_PAUSED':
      return a.params.daily_budget ? [a.params.daily_budget] : [];
    case 'CREATE_ADSET_PAUSED':
      return [a.params.daily_budget, a.params.lifetime_budget].filter((x): x is NonNullable<typeof x> => x !== null);
    case 'SET_DAILY_BUDGET':
    case 'SET_LIFETIME_BUDGET':
      return [a.before, a.after];
    default:
      return [];
  }
}

const LEVEL_PARENT: Record<string, { parentKind: Action['kind']; parentType: RemoteEntity['entity_type'] }> = {
  CREATE_ADSET_PAUSED: { parentKind: 'CREATE_CAMPAIGN_PAUSED', parentType: 'campaign' },
  CREATE_AD_PAUSED: { parentKind: 'CREATE_ADSET_PAUSED', parentType: 'adset' },
};

/** Structural checks: unique ids, dependency DAG, local_ref resolution, budget level. */
function checkGraph(actions: readonly Action[], remote: ReadonlyMap<string, RemoteEntity>, c: Collector): void {
  const ids = new Set<string>();
  const byLocalRef = new Map<string, Action>();
  const position = new Map<string, number>();
  actions.forEach((a, i) => {
    if (ids.has(a.action_id)) c.block('R_DAG_UNIQUE', 'INPUT_INVALID', `action_id ${a.action_id} bị trùng`, a.action_id);
    ids.add(a.action_id);
    position.set(a.action_id, i);
    if ('local_ref' in a) {
      if (byLocalRef.has(a.local_ref)) c.block('R_DAG_LOCAL_REF', 'INPUT_INVALID', `local_ref ${a.local_ref} bị trùng`, a.action_id);
      byLocalRef.set(a.local_ref, a);
    }
  });
  for (const a of actions) {
    for (const dep of a.depends_on) {
      const p = position.get(dep);
      // Dependencies must point at earlier actions: this rules out cycles and gives a topological order.
      if (p === undefined || p >= (position.get(a.action_id) ?? 0)) {
        c.block('R_DAG_ORDER', 'INPUT_INVALID', `depends_on ${dep} không tồn tại hoặc không đứng trước`, a.action_id);
      }
    }
    if (a.kind === 'CREATE_ADSET_PAUSED' || a.kind === 'CREATE_AD_PAUSED') {
      const rule = LEVEL_PARENT[a.kind]!;
      if ('local_ref' in a.parent) {
        const parent = byLocalRef.get(a.parent.local_ref);
        if (!parent || parent.kind !== rule.parentKind) {
          c.block('R_DAG_PARENT', 'INPUT_INVALID', `parent local_ref ${a.parent.local_ref} không hợp lệ cho ${a.kind}`, a.action_id);
        } else if (!a.depends_on.includes(parent.action_id)) {
          c.block('R_DAG_PARENT_DEP', 'INPUT_INVALID', `Phải khai báo depends_on tới ${parent.action_id}`, a.action_id);
        }
      } else {
        const parent = remote.get(a.parent.entity_id);
        if (!parent || parent.entity_type !== rule.parentType) {
          c.block('R_DAG_PARENT_REMOTE', 'INPUT_INVALID', `Đối tượng cha ${a.parent.entity_id} không tồn tại trên remote snapshot`, a.action_id);
        }
      }
    }
    if (a.kind === 'CREATE_ADSET_PAUSED') {
      const { daily_budget, lifetime_budget } = a.params;
      if (daily_budget && lifetime_budget) c.block('R_BUDGET_ONE_KIND', 'INPUT_INVALID', 'Ad set không được có cả daily và lifetime budget', a.action_id);
      const parentHasBudget =
        'local_ref' in a.parent
          ? (() => {
              const p = byLocalRef.get(a.parent.local_ref);
              return p?.kind === 'CREATE_CAMPAIGN_PAUSED' && p.params.daily_budget !== null;
            })()
          : (() => {
              const p = remote.get(a.parent.entity_id);
              return !!p && (p.daily_budget_minor !== null || p.lifetime_budget_minor !== null);
            })();
      if (parentHasBudget && (daily_budget || lifetime_budget)) {
        c.block('R_BUDGET_LEVEL', 'INPUT_INVALID', 'Campaign đã có budget; ad set không được đặt budget (tránh double-count)', a.action_id);
      }
    }
  }
}

function checkSchedule(a: Action, now: Date, c: Collector): void {
  if (a.kind !== 'CREATE_ADSET_PAUSED') return;
  const { start_time, end_time, schedule_timezone, lifetime_budget } = a.params;
  if (!isValidTimezone(schedule_timezone)) c.block('R_SCHEDULE_TZ', 'INPUT_INVALID', `Timezone ${schedule_timezone} không hợp lệ`, a.action_id);
  if (Date.parse(start_time) < now.getTime()) c.block('R_SCHEDULE_PAST', 'INPUT_INVALID', 'start_time nằm trong quá khứ', a.action_id);
  if (end_time !== null && Date.parse(end_time) <= Date.parse(start_time)) {
    c.block('R_SCHEDULE_ORDER', 'INPUT_INVALID', 'end_time phải sau start_time', a.action_id);
  }
  if (lifetime_budget && end_time === null) c.block('R_SCHEDULE_LIFETIME_END', 'INPUT_INVALID', 'Lifetime budget cần end_time', a.action_id);
}

function checkChangeLimit(a: Action, cfg: BusinessConfig, c: Collector): void {
  if (a.kind !== 'SET_DAILY_BUDGET' && a.kind !== 'SET_LIFETIME_BUDGET') return;
  const before = a.before.amount_minor;
  const delta = Math.abs(a.after.amount_minor - before);
  if (delta === 0) {
    c.block('R_NOOP', 'INPUT_INVALID', 'Before và after giống nhau', a.action_id);
    return;
  }
  if (cfg.max_change_amount_minor !== null && delta > cfg.max_change_amount_minor) {
    c.block('R_CHANGE_AMOUNT', 'BUDGET_CAP_EXCEEDED', `Thay đổi ${delta} vượt giới hạn tuyệt đối ${cfg.max_change_amount_minor}`, a.action_id);
  }
  if (cfg.max_change_pct !== null) {
    // before == 0 has no defined percentage; treat as exceeding unless the owner allows unlimited (no rule).
    if (before === 0 || new Decimal(delta).div(before).greaterThan(cfg.max_change_pct)) {
      c.block('R_CHANGE_PCT', 'BUDGET_CAP_EXCEEDED', `Thay đổi vượt ${new Decimal(cfg.max_change_pct).mul(100).toString()}%`, a.action_id);
    }
  }
}

/** Evaluate a draft against the deterministic policy. Model output never bypasses this. */
export function evaluatePolicy(draft: ProposalDraft, ctx: PolicyContext): PolicyResult {
  const c = new Collector();
  const cfg = ctx.config;
  const remote = new Map(ctx.remote.map((e) => [e.entity_id, e]));

  // Mode gates.
  if (draft.mode === 'read_only') c.block('R_MODE_READ_ONLY', 'PERMISSION_DENIED', 'Chế độ read_only không cho phép ghi');
  if (draft.mode === 'approval') {
    if (!ctx.liveWritesEnabled) c.block('R_MODE_LIVE_FLAG', 'PERMISSION_DENIED', 'LIVE_WRITES_ENABLED=false: không thể tạo proposal ghi thật');
    if (!ctx.accountAllowlist.includes(draft.ad_account_id)) c.block('R_MODE_ALLOWLIST', 'PERMISSION_DENIED', 'Ad account không nằm trong allowlist của operator');
  }
  if (ctx.frozen) c.block('R_FREEZE', 'WRITE_FROZEN', 'Hệ thống đang khóa ghi nội bộ (kill switch)');

  // Config gates.
  if (!cfg) {
    c.block('R_CONFIG_MISSING', 'POLICY_BLOCKED', 'Chưa có BusinessConfig');
  } else {
    if (cfg.tenant_id !== draft.tenant_id || cfg.ad_account_id !== draft.ad_account_id) {
      c.block('R_TENANT_ACCOUNT', 'TENANT_MISMATCH', 'Proposal không khớp tenant/ad account của config');
    }
    if (cfg.status !== 'confirmed' || cfg.confirmed_by === null) c.block('R_CONFIG_CONFIRMED', 'POLICY_BLOCKED', 'Owner chưa xác nhận config/caps');
    const missing = missingCaps(cfg);
    if (missing.length > 0) c.block('R_CAPS_PRESENT', 'POLICY_BLOCKED', `Thiếu cấu hình bắt buộc: ${missing.join(', ')}`);
    if (cfg.account_currency !== cfg.store_currency && (cfg.fx.source === null || cfg.fx.method === null)) {
      c.block('R_FX', 'CURRENCY_MISMATCH', 'Account và store khác tiền tệ nhưng chưa có nguồn/phương pháp FX');
    }
  }

  if (Date.parse(draft.expires_at) <= ctx.now.getTime()) c.block('R_TTL', 'APPROVAL_EXPIRED', 'Proposal đã hết hạn');

  // Data freshness: executable mutations need at least one fresh, complete source snapshot.
  if (draft.source_snapshot_ids.length === 0) c.block('R_FRESHNESS_SOURCE', 'DATA_INCOMPLETE', 'Proposal không có source snapshot');
  for (const id of draft.source_snapshot_ids) {
    const s = ctx.snapshots.get(id);
    if (!s || s.tenant_id !== draft.tenant_id) {
      c.block('R_FRESHNESS_SOURCE', 'DATA_INCOMPLETE', `Không tìm thấy snapshot ${id}`);
      continue;
    }
    if (s.completeness !== 'complete') c.block('R_COMPLETENESS', 'DATA_INCOMPLETE', `Snapshot ${id} chưa đầy đủ`);
    if (cfg?.freshness_seconds != null && ctx.now.getTime() - Date.parse(s.fetched_at) > cfg.freshness_seconds * 1000) {
      c.block('R_FRESHNESS', 'DATA_STALE', `Snapshot ${id} đã cũ hơn ${cfg.freshness_seconds}s`);
    }
  }

  checkGraph(draft.actions, remote, c);

  const hasCreate = draft.actions.some((a) => a.kind.startsWith('CREATE_'));
  for (const a of draft.actions) {
    if (cfg) {
      for (const m of moneyOf(a)) {
        if (m.currency !== cfg.account_currency) {
          c.block('R_CURRENCY', 'CURRENCY_MISMATCH', `Tiền tệ ${m.currency} khác account_currency ${cfg.account_currency}`, a.action_id);
        }
      }
      checkChangeLimit(a, cfg, c);
    }
    checkSchedule(a, ctx.now, c);

    if (a.kind === 'SET_DAILY_BUDGET' || a.kind === 'SET_LIFETIME_BUDGET' || a.kind === 'SET_STATUS') {
      const e = remote.get(a.entity_id);
      if (!e || e.entity_type !== a.entity_type) {
        c.block('R_ENTITY_EXISTS', 'REMOTE_DRIFT', `Không thấy ${a.entity_type} ${a.entity_id} trong remote snapshot`, a.action_id);
      } else {
        if (remoteFingerprint(e) !== a.preconditions.remote_fingerprint || e.status !== a.preconditions.status) {
          c.block('R_BEFORE_FINGERPRINT', 'REMOTE_DRIFT', 'Trạng thái remote đã khác lúc lập proposal', a.action_id);
        }
        const actual =
          a.kind === 'SET_DAILY_BUDGET' ? e.daily_budget_minor : a.kind === 'SET_LIFETIME_BUDGET' ? e.lifetime_budget_minor : null;
        if (a.kind === 'SET_STATUS' ? e.status !== a.before.status : actual !== a.before.amount_minor) {
          c.block('R_BEFORE_MATCH', 'REMOTE_DRIFT', 'Giá trị before không khớp remote', a.action_id);
        }
        if (a.kind === 'SET_DAILY_BUDGET' && e.daily_budget_minor === null) {
          c.block('R_BUDGET_KIND', 'INPUT_INVALID', 'Đối tượng không dùng daily budget', a.action_id);
        }
        const changed = ctx.lastChangedAt.get(a.entity_id);
        if (cfg?.cooldown_seconds != null && changed && ctx.now.getTime() - changed.getTime() < cfg.cooldown_seconds * 1000) {
          c.block('R_COOLDOWN', 'POLICY_BLOCKED', `Đối tượng vừa thay đổi, còn trong cooldown ${cfg.cooldown_seconds}s`, a.action_id);
        }
      }
    }

    if (a.kind === 'SET_STATUS') {
      if (a.before.status === a.after.status) c.block('R_NOOP', 'INPUT_INVALID', 'Status không đổi', a.action_id);
      if (a.after.status === 'ACTIVE') {
        if (hasCreate) c.block('R_ACTIVATION_SEPARATE', 'POLICY_BLOCKED', 'Kích hoạt phải là proposal riêng, không gộp với tạo mới', a.action_id);
        if (!ctx.verifiedEntityIds.has(a.entity_id)) {
          c.block('R_ACTIVATION_VERIFIED', 'POLICY_BLOCKED', 'Chỉ kích hoạt đối tượng đã được remote readback xác minh', a.action_id);
        }
      }
    }

    if (a.kind === 'CREATE_CAMPAIGN_PAUSED' || a.kind === 'CREATE_ADSET_PAUSED') {
      const caps = ctx.capabilities;
      if (!caps || !caps.verified) {
        c.block('R_CAPABILITY', 'CAPABILITY_UNSUPPORTED', 'Capability snapshot chưa xác minh — không dùng enum chưa kiểm', a.action_id);
      } else if (a.kind === 'CREATE_CAMPAIGN_PAUSED' && !caps.objectives.includes(a.params.objective)) {
        c.block('R_CAPABILITY', 'CAPABILITY_UNSUPPORTED', `Objective ${a.params.objective} chưa được xác minh`, a.action_id);
      } else if (
        a.kind === 'CREATE_ADSET_PAUSED' &&
        (!caps.optimization_goals.includes(a.params.optimization_goal) || !caps.billing_events.includes(a.params.billing_event))
      ) {
        c.block('R_CAPABILITY', 'CAPABILITY_UNSUPPORTED', 'Optimization goal/billing event chưa được xác minh', a.action_id);
      }
    }

    if (a.kind === 'CREATE_AD_PAUSED') {
      const review = ctx.reviews.get(a.params.review_id);
      const asset = ctx.assets.get(a.params.creative_asset_id);
      if (!asset || asset.sha256 !== a.params.creative_sha256) {
        c.block('R_ASSET_HASH', 'PAYLOAD_CHANGED', 'Asset không tồn tại hoặc hash đã đổi', a.action_id);
      } else if (asset.rights_status !== 'verified') {
        c.block('R_ASSET_RIGHTS', 'POLICY_BLOCKED', 'Thiếu bằng chứng quyền sử dụng asset', a.action_id);
      }
      if (!review || review.reviewed_sha256 !== a.params.creative_sha256) {
        c.block('R_REVIEW_STALE', 'POLICY_BLOCKED', 'Review policy/IP không còn hiệu lực cho asset này', a.action_id);
      } else if (review.policy_version !== POLICY_VERSION) {
        c.block('R_REVIEW_POLICY_VERSION', 'POLICY_BLOCKED', 'Review dùng policy version cũ', a.action_id);
      } else if (review.decision === 'block' || (review.decision === 'warn' && !review.human_reviewed)) {
        c.block('R_REVIEW_DECISION', 'POLICY_BLOCKED', 'Review chưa đạt (block hoặc warn chưa có người duyệt)', a.action_id);
      }
    }
  }

  // Caps on totals, including other proposals' reservations.
  if (cfg && missingCaps(cfg).length === 0) {
    const impact = computeImpact(draft.actions, ctx.remote, cfg.account_currency);
    const totals = accountTotals(ctx.remote);
    const dailyAfter = totals.daily_minor + ctx.reserved.daily_minor + Math.max(0, impact.daily_budget_delta_minor);
    if (dailyAfter > cfg.caps.daily_budget_cap_minor!) {
      c.block('R_DAILY_CAP', 'BUDGET_CAP_EXCEEDED', `Tổng daily budget (gồm reservation) ${dailyAfter} vượt trần ${cfg.caps.daily_budget_cap_minor}`);
    }
    const lifetimeAfter = totals.lifetime_minor + ctx.reserved.lifetime_minor + Math.max(0, impact.lifetime_budget_delta_minor);
    if (lifetimeAfter > cfg.caps.lifetime_budget_cap_minor!) {
      c.block('R_LIFETIME_CAP', 'BUDGET_CAP_EXCEEDED', `Tổng lifetime budget ${lifetimeAfter} vượt trần ${cfg.caps.lifetime_budget_cap_minor}`);
    }
    if (impact.exposure_minor > cfg.caps.proposal_exposure_cap_minor!) {
      c.block('R_EXPOSURE_CAP', 'BUDGET_CAP_EXCEEDED', `Exposure ${impact.exposure_minor} vượt trần proposal ${cfg.caps.proposal_exposure_cap_minor}`);
    }
    if (impact.daily_budget_delta_minor > 0) c.warnings.push('Daily budget của nền tảng không phải trần chi tiêu thực tế; chi tiêu ngày có thể vượt.');
  }

  return {
    decision: c.violations.length === 0 ? 'pass' : 'block',
    policy_version: POLICY_VERSION,
    violations: c.violations,
    warnings: c.warnings,
    evaluated_at: ctx.now.toISOString(),
  };
}

/** Owner-confirmed values required before any executable proposal. Demo numbers are never substituted. */
export function missingCaps(cfg: BusinessConfig): string[] {
  const missing: string[] = [];
  if (cfg.caps.daily_budget_cap_minor === null) missing.push('caps.daily_budget_cap_minor');
  if (cfg.caps.lifetime_budget_cap_minor === null) missing.push('caps.lifetime_budget_cap_minor');
  if (cfg.caps.proposal_exposure_cap_minor === null) missing.push('caps.proposal_exposure_cap_minor');
  if (cfg.max_change_pct === null) missing.push('max_change_pct');
  if (cfg.max_change_amount_minor === null) missing.push('max_change_amount_minor');
  if (cfg.freshness_seconds === null) missing.push('freshness_seconds');
  if (cfg.cooldown_seconds === null) missing.push('cooldown_seconds');
  if (cfg.approval_ttl_seconds === null) missing.push('approval_ttl_seconds');
  return missing;
}
