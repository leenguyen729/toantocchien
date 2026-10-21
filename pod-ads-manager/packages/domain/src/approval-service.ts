import { createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError, canonicalize, type ActionProposal, type ApprovalRecord } from '@pod/contracts';
import { evaluatePolicy } from '@pod/policy';
import { audit, type Deps } from './context';
import { newId } from './ids';
import { buildPolicyContext } from './policy-context';
import { computePayloadHash } from './proposal-service';
import { matchingGrants, type Principal } from './rbac';
import type { Store } from './store/types';

type Unsigned = Omit<ApprovalRecord, 'signature'>;

export function signApproval(rec: Unsigned, secret: Buffer): string {
  return createHmac('sha256', secret).update(canonicalize(rec)).digest('hex');
}

export function verifyApprovalSignature(rec: ApprovalRecord, keys: ReadonlyMap<string, Buffer>): boolean {
  const secret = keys.get(rec.key_id);
  if (!secret) return false;
  const { signature, ...rest } = rec;
  const expected = Buffer.from(signApproval(rest, secret), 'hex');
  const given = Buffer.from(signature, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export type ApprovalCheck = { ok: true; approval: ApprovalRecord } | { ok: false; code: 'APPROVAL_REQUIRED' | 'APPROVAL_EXPIRED' | 'PAYLOAD_CHANGED'; message: string };

/**
 * Server-side approval verification used at enqueue AND by the worker before
 * each mutation. A chat message saying "đồng ý" never produces an ApprovalRecord.
 */
export async function checkApproval(d: Deps, s: Store, proposal: ActionProposal): Promise<ApprovalCheck> {
  const recomputed = computePayloadHash(proposal);
  if (recomputed !== proposal.payload_hash) return { ok: false, code: 'PAYLOAD_CHANGED', message: 'Payload proposal không khớp hash đã lưu' };
  const approvals = await s.listApprovals(proposal.tenant_id, proposal.proposal_id, proposal.revision);
  const keys = new Map([[d.runtime.signingKey.key_id, d.runtime.signingKey.secret]]);
  const valid = approvals.filter(
    (a) => a.decision === 'approved' && a.payload_hash === proposal.payload_hash && a.tenant_id === proposal.tenant_id && a.scope.ad_account_id === proposal.ad_account_id && verifyApprovalSignature(a, keys),
  );
  if (valid.length === 0) {
    const forged = approvals.some((a) => a.decision === 'approved');
    return { ok: false, code: forged ? 'PAYLOAD_CHANGED' : 'APPROVAL_REQUIRED', message: forged ? 'Approval không hợp lệ (chữ ký/hash/scope sai)' : 'Chưa có approval hợp lệ' };
  }
  const approval = valid[valid.length - 1]!;
  if (Date.parse(approval.expires_at) <= d.clock.now().getTime()) return { ok: false, code: 'APPROVAL_EXPIRED', message: 'Approval đã hết hạn' };
  return { ok: true, approval };
}

export class ApprovalService {
  constructor(private readonly d: Deps) {}

  /**
   * Record a human decision. Exposed only to the authenticated UI route —
   * never to the Claude tool manifest. `expectedPayloadHash` is the hash the
   * approver saw; any difference means they did not review this payload.
   */
  async decide(
    p: Principal,
    proposalId: string,
    revision: number,
    expectedPayloadHash: string,
    decision: 'approved' | 'rejected',
    comment: string | null,
  ): Promise<ApprovalRecord> {
    if (p.kind !== 'human') throw new DomainError('PERMISSION_DENIED', 'Chỉ con người đã xác thực mới được duyệt');
    const r = await this.d.store.tx(async (s): Promise<ApprovalRecord | 'expired'> => {
      const proposal = await s.getProposal(p.tenant_id, proposalId, revision);
      if (!proposal) throw new DomainError('INPUT_INVALID', 'Không tìm thấy proposal');
      const grants = matchingGrants(p, 'proposal.approve', proposal.ad_account_id);
      if (grants.length === 0) throw new DomainError('PERMISSION_DENIED', 'Không có quyền duyệt trên ad account này');
      if (proposal.status !== 'PENDING_APPROVAL') throw new DomainError('APPROVAL_REQUIRED', `Proposal đang ${proposal.status}, không chờ duyệt`);
      const now = this.d.clock.now();
      if (Date.parse(proposal.expires_at) <= now.getTime()) {
        await s.casProposalStatus(p.tenant_id, proposalId, revision, 'PENDING_APPROVAL', 'EXPIRED');
        await audit(s, this.d.clock, p, proposalId, 'proposal.expired', { revision }, 'Hết hạn trước khi duyệt');
        // Return instead of throwing so the EXPIRED transition commits.
        return 'expired';
      }
      if (computePayloadHash(proposal) !== proposal.payload_hash || expectedPayloadHash !== proposal.payload_hash) {
        throw new DomainError('PAYLOAD_CHANGED', 'Hash không khớp nội dung đang hiển thị; tải lại proposal');
      }
      const cfg = await s.getLatestConfig(p.tenant_id, proposal.ad_account_id);

      if (decision === 'approved') {
        if (cfg?.separation_of_duties && proposal.created_by === p.actor_id) {
          throw new DomainError('PERMISSION_DENIED', 'Separation of duties: người tạo không được tự duyệt');
        }
        const limitOk = grants.some(
          (g) =>
            g.approval_limit_minor !== undefined &&
            g.approval_limit_currency === proposal.impact.currency &&
            proposal.impact.exposure_minor <= g.approval_limit_minor,
        );
        if (!limitOk) throw new DomainError('PERMISSION_DENIED', 'Exposure vượt hạn mức duyệt của bạn');
        // Re-check against current remote state so a drifted proposal is not approved blind.
        const ctx = await buildPolicyContext(this.d, s, p.tenant_id, proposal.ad_account_id, proposal.actions, proposal.source_snapshot_ids, {
          proposal_id: proposalId,
          revision,
        });
        const policy = evaluatePolicy(proposal, ctx);
        if (policy.decision === 'block') {
          await s.putPolicyResult(p.tenant_id, proposalId, revision, policy);
          throw new DomainError('POLICY_BLOCKED', `Policy hiện chặn: ${policy.violations.map((v) => v.rule_id).join(', ')}`);
        }
      }

      const ttlMs = (cfg?.approval_ttl_seconds ?? 1800) * 1000;
      const expiresAt = new Date(Math.min(Date.parse(proposal.expires_at), now.getTime() + ttlMs)).toISOString();
      const approverGrant = grants[0]!;
      const unsigned: Unsigned = {
        approval_id: newId('apr'),
        tenant_id: p.tenant_id,
        proposal_id: proposalId,
        revision,
        payload_hash: proposal.payload_hash,
        actor_id: p.actor_id,
        role: 'approver',
        decision,
        decided_at: now.toISOString(),
        expires_at: expiresAt,
        scope: {
          ad_account_id: proposal.ad_account_id,
          exposure_limit_minor: approverGrant.approval_limit_minor ?? 0,
          currency: approverGrant.approval_limit_currency ?? proposal.impact.currency,
        },
        key_id: this.d.runtime.signingKey.key_id,
        comment: comment ? comment.slice(0, 1000) : null,
      };
      const record: ApprovalRecord = { ...unsigned, signature: signApproval(unsigned, this.d.runtime.signingKey.secret) };
      await s.insertApproval(record);
      const to = decision === 'approved' ? 'APPROVED' : 'REJECTED';
      if (!(await s.casProposalStatus(p.tenant_id, proposalId, revision, 'PENDING_APPROVAL', to))) {
        throw new DomainError('INPUT_INVALID', 'Trạng thái vừa thay đổi');
      }
      await audit(s, this.d.clock, p, proposalId, `approval.${decision}`, record, `${p.display_name} ${decision === 'approved' ? 'duyệt' : 'từ chối'} r${revision}`);
      return record;
    });
    if (r === 'expired') throw new DomainError('APPROVAL_EXPIRED', 'Proposal đã hết hạn');
    return r;
  }

  async status(p: Principal, proposalId: string, revision: number): Promise<'none' | 'approved' | 'rejected' | 'expired'> {
    const proposal = await this.d.store.getProposal(p.tenant_id, proposalId, revision);
    if (!proposal) throw new DomainError('INPUT_INVALID', 'Không tìm thấy proposal');
    const list = await this.d.store.listApprovals(p.tenant_id, proposalId, revision);
    const last = list[list.length - 1];
    if (!last) return 'none';
    if (last.decision === 'rejected') return 'rejected';
    return Date.parse(last.expires_at) <= this.d.clock.now().getTime() ? 'expired' : 'approved';
  }
}
