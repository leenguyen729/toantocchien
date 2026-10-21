import { DomainError, assertValid, canonicalHash, type Action, type ActionProposal, type CapsSnapshot, type PolicyResult } from '@pod/contracts';
import { POLICY_VERSION, computeImpact, evaluatePolicy } from '@pod/policy';
import { audit, type Deps } from './context';
import { newId } from './ids';
import { buildPolicyContext } from './policy-context';
import { assertCan, type Principal } from './rbac';
import { TERMINAL } from './state-machine';
import type { Store } from './store/types';

export type ProposeInput = {
  ad_account_id: string;
  store_id: string;
  proposal_id?: string | null;
  actions: Action[];
  reason: string;
  rollback_plan: string;
  source_snapshot_ids: string[];
};

const DEFAULT_TTL_SECONDS = 1800;

/** Everything the human approves. Status/timestamps of later steps are excluded; expiry is included so TTL cannot be stretched. */
export function proposalHashBasis(p: ActionProposal): Record<string, unknown> {
  return {
    schema_version: p.schema_version,
    proposal_id: p.proposal_id,
    tenant_id: p.tenant_id,
    store_id: p.store_id,
    ad_account_id: p.ad_account_id,
    revision: p.revision,
    mode: p.mode,
    created_by: p.created_by,
    expires_at: p.expires_at,
    policy_version: p.policy_version,
    caps: p.caps,
    source_snapshot_ids: p.source_snapshot_ids,
    actions: p.actions,
    impact: p.impact,
    risk_flags: p.risk_flags,
    reason: p.reason,
    rollback_plan: p.rollback_plan,
  };
}

export const computePayloadHash = (p: ActionProposal): string => canonicalHash(proposalHashBasis(p));

function riskFlags(actions: readonly Action[], policy: PolicyResult): string[] {
  const flags = new Set<string>();
  for (const a of actions) {
    if (a.kind === 'SET_STATUS' && a.after.status === 'ACTIVE') flags.add('ACTIVATES_DELIVERY');
    if ((a.kind === 'SET_DAILY_BUDGET' || a.kind === 'SET_LIFETIME_BUDGET') && a.after.amount_minor > a.before.amount_minor) flags.add('BUDGET_INCREASE');
    if (a.kind.startsWith('CREATE_')) flags.add('CREATES_ENTITIES');
  }
  if (policy.warnings.length > 0) flags.add('HAS_WARNINGS');
  return [...flags].sort();
}

export class ProposalService {
  constructor(private readonly d: Deps) {}

  /**
   * Create a proposal revision. Policy runs server-side; a passing revision goes
   * DRAFT → VALIDATED → PENDING_APPROVAL, a blocked one stays DRAFT with its violations.
   * Revising supersedes the previous revision and voids any approval on it.
   */
  async propose(p: Principal, input: ProposeInput): Promise<{ proposal: ActionProposal; policy: PolicyResult }> {
    assertCan(p, 'proposal.create', input.ad_account_id);
    for (const a of input.actions) assertValid<Action>('Action', a);
    if (input.actions.length === 0 || input.actions.length > 50) throw new DomainError('INPUT_INVALID', 'Cần 1–50 action');

    return this.d.store.tx(async (s) => {
      const now = this.d.clock.now();
      let proposalId = input.proposal_id ?? newId('prp');
      let revision = 1;
      const prev = input.proposal_id ? await s.getLatestProposal(p.tenant_id, input.proposal_id) : null;
      if (input.proposal_id && !prev) throw new DomainError('INPUT_INVALID', 'Không tìm thấy proposal để tạo revision');
      if (prev) {
        if (prev.ad_account_id !== input.ad_account_id) throw new DomainError('TENANT_MISMATCH', 'Không được đổi ad account giữa các revision');
        await this.supersede(s, p, prev);
        proposalId = prev.proposal_id;
        revision = prev.revision + 1;
      }

      const ctx = await buildPolicyContext(this.d, s, p.tenant_id, input.ad_account_id, input.actions, input.source_snapshot_ids);
      const cfg = ctx.config;
      const ttl = cfg?.approval_ttl_seconds ?? DEFAULT_TTL_SECONDS;
      const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
      const draftForPolicy = {
        tenant_id: p.tenant_id,
        ad_account_id: input.ad_account_id,
        mode: this.d.runtime.mode,
        expires_at: expiresAt,
        source_snapshot_ids: input.source_snapshot_ids,
        actions: input.actions as ActionProposal['actions'],
      };
      const policy = evaluatePolicy(draftForPolicy, ctx);
      const currency = cfg?.account_currency ?? 'USD';
      const caps: CapsSnapshot | null =
        cfg &&
        cfg.caps.daily_budget_cap_minor !== null &&
        cfg.caps.lifetime_budget_cap_minor !== null &&
        cfg.caps.proposal_exposure_cap_minor !== null &&
        cfg.max_change_pct !== null &&
        cfg.max_change_amount_minor !== null &&
        cfg.cooldown_seconds !== null
          ? {
              config_version: cfg.version,
              daily_budget_cap_minor: cfg.caps.daily_budget_cap_minor,
              lifetime_budget_cap_minor: cfg.caps.lifetime_budget_cap_minor,
              proposal_exposure_cap_minor: cfg.caps.proposal_exposure_cap_minor,
              max_change_pct: cfg.max_change_pct,
              max_change_amount_minor: cfg.max_change_amount_minor,
              cooldown_seconds: cfg.cooldown_seconds,
              currency: cfg.account_currency,
            }
          : null;

      const proposal: ActionProposal = {
        schema_version: '1.0',
        proposal_id: proposalId,
        tenant_id: p.tenant_id,
        store_id: input.store_id,
        ad_account_id: input.ad_account_id,
        revision,
        status: 'DRAFT',
        mode: this.d.runtime.mode,
        created_at: now.toISOString(),
        created_by: p.actor_id,
        created_by_kind: p.kind,
        expires_at: expiresAt,
        policy_version: POLICY_VERSION,
        caps,
        source_snapshot_ids: input.source_snapshot_ids,
        actions: input.actions as ActionProposal['actions'],
        impact: computeImpact(input.actions, ctx.remote, currency),
        risk_flags: riskFlags(input.actions, policy),
        reason: input.reason,
        rollback_plan: input.rollback_plan,
        payload_hash: '0'.repeat(64),
      };
      proposal.payload_hash = computePayloadHash(proposal);
      assertValid<ActionProposal>('ActionProposal', proposal);
      await s.insertProposal(proposal);
      await s.putPolicyResult(p.tenant_id, proposalId, revision, policy);
      await audit(s, this.d.clock, p, proposalId, 'proposal.created', proposal, `Tạo proposal ${proposalId} r${revision} (${input.actions.length} action)`);

      if (policy.decision === 'pass') {
        await s.casProposalStatus(p.tenant_id, proposalId, revision, 'DRAFT', 'VALIDATED');
        await s.casProposalStatus(p.tenant_id, proposalId, revision, 'VALIDATED', 'PENDING_APPROVAL');
        proposal.status = 'PENDING_APPROVAL';
        await audit(s, this.d.clock, p, proposalId, 'proposal.submitted', { hash: proposal.payload_hash }, 'Policy đạt; chờ người duyệt');
      } else {
        await audit(s, this.d.clock, p, proposalId, 'proposal.policy_blocked', policy, `Policy chặn: ${policy.violations.map((v) => v.rule_id).join(', ')}`);
      }
      return { proposal, policy };
    });
  }

  private async supersede(s: Store, p: Principal, prev: ActionProposal): Promise<void> {
    if (TERMINAL.has(prev.status) || prev.status === 'DRAFT') return;
    const to = prev.status === 'PENDING_APPROVAL' ? 'CANCELLED' : prev.status === 'APPROVED' || prev.status === 'QUEUED' ? 'INVALIDATED' : null;
    if (!to) throw new DomainError('INPUT_INVALID', `Revision trước đang ${prev.status}; không thể tạo revision mới lúc này`);
    if (!(await s.casProposalStatus(p.tenant_id, prev.proposal_id, prev.revision, prev.status, to))) {
      throw new DomainError('INPUT_INVALID', 'Trạng thái proposal vừa thay đổi; thử lại');
    }
    if (prev.status === 'QUEUED') await s.releaseReservations(p.tenant_id, prev.proposal_id, prev.revision, this.d.clock.now().toISOString());
    await audit(s, this.d.clock, p, prev.proposal_id, 'proposal.superseded', { revision: prev.revision, to }, `Revision ${prev.revision} → ${to} vì có revision mới`);
  }

  async get(p: Principal, proposalId: string, revision?: number): Promise<{ proposal: ActionProposal; policy: PolicyResult | null } | null> {
    const proposal = revision ? await this.d.store.getProposal(p.tenant_id, proposalId, revision) : await this.d.store.getLatestProposal(p.tenant_id, proposalId);
    if (!proposal) return null;
    assertCan(p, 'report.read', proposal.ad_account_id);
    return { proposal, policy: await this.d.store.getPolicyResult(p.tenant_id, proposal.proposal_id, proposal.revision) };
  }

  async list(p: Principal, adAccountId?: string): Promise<ActionProposal[]> {
    const all = await this.d.store.listProposals(p.tenant_id, adAccountId ? { ad_account_id: adAccountId } : {});
    return all.filter((x) => {
      try {
        assertCan(p, 'report.read', x.ad_account_id);
        return true;
      } catch {
        return false;
      }
    });
  }

  /** Re-run policy against current state without changing anything (S17 proposal.validate). */
  async revalidate(p: Principal, proposalId: string, revision: number): Promise<PolicyResult> {
    const proposal = await this.d.store.getProposal(p.tenant_id, proposalId, revision);
    if (!proposal) throw new DomainError('INPUT_INVALID', 'Không tìm thấy proposal');
    assertCan(p, 'report.read', proposal.ad_account_id);
    const ctx = await buildPolicyContext(this.d, this.d.store, p.tenant_id, proposal.ad_account_id, proposal.actions, proposal.source_snapshot_ids, {
      proposal_id: proposalId,
      revision,
    });
    return evaluatePolicy(proposal, ctx);
  }

  async cancel(p: Principal, proposalId: string, revision: number): Promise<void> {
    await this.d.store.tx(async (s) => {
      const proposal = await s.getProposal(p.tenant_id, proposalId, revision);
      if (!proposal) throw new DomainError('INPUT_INVALID', 'Không tìm thấy proposal');
      assertCan(p, 'proposal.cancel', proposal.ad_account_id);
      if (!['PENDING_APPROVAL', 'APPROVED', 'QUEUED'].includes(proposal.status)) {
        throw new DomainError('INPUT_INVALID', `Không hủy được proposal đang ${proposal.status}`);
      }
      if (!(await s.casProposalStatus(p.tenant_id, proposalId, revision, proposal.status, 'CANCELLED'))) {
        throw new DomainError('INPUT_INVALID', 'Trạng thái vừa thay đổi');
      }
      await s.releaseReservations(p.tenant_id, proposalId, revision, this.d.clock.now().toISOString());
      await audit(s, this.d.clock, p, proposalId, 'proposal.cancelled', { revision }, `Hủy proposal r${revision}`);
    });
  }

  /** Housekeeping: expire pending/approved/queued proposals past TTL. */
  async expireDue(tenantId: string): Promise<number> {
    const now = this.d.clock.now();
    const due = (await this.d.store.listProposals(tenantId, { statuses: ['PENDING_APPROVAL', 'APPROVED', 'QUEUED'] })).filter(
      (x) => Date.parse(x.expires_at) <= now.getTime(),
    );
    for (const x of due) {
      await this.d.store.tx(async (s) => {
        if (await s.casProposalStatus(tenantId, x.proposal_id, x.revision, x.status, 'EXPIRED')) {
          await s.releaseReservations(tenantId, x.proposal_id, x.revision, now.toISOString());
          await audit(s, this.d.clock, { actor_id: 'system', tenant_id: tenantId, kind: 'system' }, x.proposal_id, 'proposal.expired', { revision: x.revision }, 'Hết hạn TTL');
        }
      });
    }
    return due.length;
  }
}
