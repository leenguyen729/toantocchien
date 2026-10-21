import { DomainError, type AuditEvent, type FreezeState, type Incident } from '@pod/contracts';
import { audit, type Deps } from './context';
import { newId } from './ids';
import { redactSecrets } from './redact';
import { assertCan, type Principal } from './rbac';
import { GENESIS_HASH } from './store/types';
import { auditEventHash } from './store/memory';

/** Shown wherever the kill switch appears. The freeze is internal only. */
export const RUNNING_ADS_NOTE =
  'Khóa ghi nội bộ chỉ chặn hệ thống này gửi thay đổi. Quảng cáo đang chạy trên Meta VẪN TIẾP TỤC chi tiêu; muốn dừng phải pause trong Ads Manager hoặc qua proposal pause được duyệt.';

export function verifyAuditChain(events: readonly AuditEvent[]): { ok: boolean; broken_at: number | null } {
  let prev = GENESIS_HASH;
  let seq = 0;
  for (const e of events) {
    const { event_hash, ...rest } = e;
    if (e.sequence !== seq + 1 || e.prev_hash !== prev || auditEventHash(rest) !== event_hash) return { ok: false, broken_at: e.sequence };
    prev = event_hash;
    seq = e.sequence;
  }
  return { ok: true, broken_at: null };
}

export type SignalKind = 'connector_error' | 'data_stale' | 'permission_lost' | 'spend_anomaly' | 'unknown_mutation' | 'audit_unavailable' | 'other';

const SEVERITY: Record<SignalKind, Incident['severity']> = {
  audit_unavailable: 'sev1',
  unknown_mutation: 'sev2',
  permission_lost: 'sev2',
  spend_anomaly: 'sev2',
  connector_error: 'sev3',
  data_stale: 'sev3',
  other: 'sev4',
};

/** Deterministic recovery checklists per signal (S18 ops.recovery.draft). */
export function recoveryChecklist(kind: SignalKind): string[] {
  const common = ['Ghi nhận thời điểm biết cuối và mức độ không chắc chắn.', 'Owner xác nhận trước khi mở lại ghi (unfreeze).'];
  const byKind: Record<SignalKind, string[]> = {
    audit_unavailable: ['Giữ khóa ghi: mọi ghi đều fail-closed khi audit hỏng.', 'Khôi phục audit store, chạy verify chuỗi hash.'],
    unknown_mutation: ['Chạy execution.reconcile cho proposal UNKNOWN.', 'Đối chiếu Ads Manager theo tag [pam:...]; không tạo lại.'],
    permission_lost: ['Thu hồi/rotate token theo runbook token-rotation.', 'Kiểm tra quyền app/Business; không xin scope rộng hơn cần.'],
    spend_anomaly: ['So sánh spend thực với budget đã duyệt; daily budget không phải trần chi tiêu.', 'Nếu cần dừng chi tiêu: owner pause trong Ads Manager hoặc lập proposal pause.'],
    connector_error: ['Kiểm tra quota/circuit breaker; chờ backoff.', 'Đánh dấu dữ liệu liên quan là stale/incomplete.'],
    data_stale: ['Chạy backfill gần nhất; không tối ưu trên dữ liệu cũ.', 'Xác nhận completeness/watermark trước khi tạo proposal.'],
    other: ['Thu thập bằng chứng (không chứa secret/PII).'],
  };
  return [...byKind[kind], ...common];
}

export class OpsService {
  constructor(private readonly d: Deps) {}

  async freeze(p: Principal, reason: string): Promise<FreezeState> {
    assertCan(p, 'ops.freeze');
    return this.d.store.tx(async (s) => {
      const state: FreezeState = { frozen: true, reason: redactSecrets(reason).slice(0, 1000), changed_by: p.actor_id, changed_at: this.d.clock.now().toISOString(), stops_running_ads: false };
      await s.setFreeze(p.tenant_id, state);
      await audit(s, this.d.clock, p, 'kill_switch', 'ops.freeze_changed', state, `Bật kill switch: ${redactSecrets(reason).slice(0, 300)}`);
      return state;
    });
  }

  /** Human owner only. Refused while an UNKNOWN/RECONCILING proposal exists unless explicitly acknowledged. */
  async unfreeze(p: Principal, reason: string, acknowledgeUnresolved = false): Promise<FreezeState> {
    assertCan(p, 'ops.unfreeze');
    return this.d.store.tx(async (s) => {
      const unresolved = await s.listProposals(p.tenant_id, { statuses: ['UNKNOWN', 'RECONCILING', 'NEEDS_REVIEW'] });
      if (unresolved.length > 0 && !acknowledgeUnresolved) {
        throw new DomainError('POLICY_BLOCKED', `Còn ${unresolved.length} proposal chưa đối soát xong; xác nhận rõ trước khi mở lại`);
      }
      const state: FreezeState = { frozen: false, reason: redactSecrets(reason).slice(0, 1000), changed_by: p.actor_id, changed_at: this.d.clock.now().toISOString(), stops_running_ads: false };
      await s.setFreeze(p.tenant_id, state);
      await audit(s, this.d.clock, p, 'kill_switch', 'ops.freeze_changed', state, `Mở lại ghi: ${redactSecrets(reason).slice(0, 300)}`);
      return state;
    });
  }

  async getFreeze(p: Principal): Promise<FreezeState> {
    assertCan(p, 'report.read');
    return this.d.store.getFreeze(p.tenant_id);
  }

  async createIncident(p: Principal, kind: SignalKind, detail: string, adAccountIds: string[], requestFreeze: boolean): Promise<{ incident: Incident; freeze: FreezeState }> {
    assertCan(p, 'ops.incident.create');
    for (const a of adAccountIds) assertCan(p, 'report.read', a);
    let freeze = await this.d.store.getFreeze(p.tenant_id);
    if (requestFreeze && !freeze.frozen) freeze = await this.freeze(p, `Incident: ${kind}`);
    return this.d.store.tx(async (s) => {
      const incident: Incident = {
        incident_id: newId('inc'),
        tenant_id: p.tenant_id,
        severity: SEVERITY[kind],
        affected_scope: { ad_account_ids: adAccountIds, components: [kind] },
        detected_at: this.d.clock.now().toISOString(),
        state: freeze.frozen ? 'contained' : 'open',
        evidence: [{ kind: 'signal', ref: newId('sig'), note: redactSecrets(detail).slice(0, 1000) }],
        containment: { writes_frozen: freeze.frozen, note: RUNNING_ADS_NOTE },
        recovery_owner: null,
        resolution: null,
      };
      await s.insertIncident(incident);
      await audit(s, this.d.clock, p, incident.incident_id, 'ops.incident_created', incident, `Incident ${incident.severity}: ${kind}`);
      return { incident, freeze };
    });
  }

  async resolveIncident(p: Principal, incidentId: string, resolution: string): Promise<Incident> {
    assertCan(p, 'ops.incident.update');
    return this.d.store.tx(async (s) => {
      const i = await s.getIncident(p.tenant_id, incidentId);
      if (!i) throw new DomainError('INPUT_INVALID', 'Không tìm thấy incident');
      const next: Incident = { ...i, state: 'resolved', resolution: redactSecrets(resolution).slice(0, 2000), recovery_owner: p.actor_id };
      await s.updateIncident(next);
      await audit(s, this.d.clock, p, incidentId, 'ops.incident_resolved', next, 'Đóng incident');
      return next;
    });
  }

  async listIncidents(p: Principal): Promise<Incident[]> {
    assertCan(p, 'ops.health');
    return this.d.store.listIncidents(p.tenant_id);
  }

  async health(p: Principal): Promise<{
    mode: string;
    live_writes_enabled: boolean;
    freeze: FreezeState;
    pending_approval: number;
    queued_jobs: number;
    unknown_or_review: number;
    open_incidents: number;
    audit_chain: { ok: boolean; broken_at: number | null; events: number };
    running_ads_note: string;
  }> {
    assertCan(p, 'ops.health');
    const s = this.d.store;
    const [freeze, pending, queued, unknown, incidents, events] = await Promise.all([
      s.getFreeze(p.tenant_id),
      s.listProposals(p.tenant_id, { statuses: ['PENDING_APPROVAL'] }),
      s.countJobs(p.tenant_id, ['pending', 'leased']),
      s.listProposals(p.tenant_id, { statuses: ['UNKNOWN', 'RECONCILING', 'NEEDS_REVIEW'] }),
      s.listIncidents(p.tenant_id),
      s.listAudit(p.tenant_id),
    ]);
    const chain = verifyAuditChain(events);
    return {
      mode: this.d.runtime.mode,
      live_writes_enabled: this.d.runtime.liveWritesEnabled,
      freeze,
      pending_approval: pending.length,
      queued_jobs: queued,
      unknown_or_review: unknown.length,
      open_incidents: incidents.filter((i) => i.state !== 'resolved').length,
      audit_chain: { ...chain, events: events.length },
      running_ads_note: RUNNING_ADS_NOTE,
    };
  }
}
