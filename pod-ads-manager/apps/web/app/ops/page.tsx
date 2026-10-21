'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, hasRole, type Health, type Incident } from '../../lib/api';
import { Time } from '../../components/format';
import { useSession } from '../../components/session';

const KINDS = ['spend_anomaly', 'unknown_mutation', 'permission_lost', 'connector_error', 'data_stale', 'audit_unavailable', 'other'] as const;

export default function OpsPage() {
  const { me, status, refresh } = useSession();
  const [health, setHealth] = useState<Health | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [reason, setReason] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('spend_anomaly');
  const [detail, setDetail] = useState('');
  const [ack, setAck] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [h, i] = await Promise.all([api<Health>('/api/ops/health'), api<{ incidents: Incident[] }>('/api/ops/incidents')]);
      setHealth(h);
      setIncidents(i.incidents);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setMsg(null);
    try {
      await fn();
      setMsg(`${label}: xong.`);
    } catch (e) {
      const ex = e as Error & { code?: string };
      setMsg(`${label} bị từ chối: ${ex.code ? `${ex.code} — ` : ''}${ex.message}`);
    }
    await load();
    await refresh();
  };

  if (err) return <p className="error">{err}</p>;
  const frozen = status?.freeze.frozen ?? false;

  return (
    <>
      <h1>Vận hành & sự cố</h1>
      <section className={`card ${frozen ? 'card-alert' : ''}`} data-testid="kill-switch">
        <h2>Kill switch (khóa ghi nội bộ): {frozen ? 'ĐANG BẬT' : 'tắt'}</h2>
        <p className="warning" data-testid="running-ads-note">
          {status?.running_ads_note}
        </p>
        {frozen && status && (
          <p>
            Bật bởi {status.freeze.changed_by} lúc <Time iso={status.freeze.changed_at} />: {status.freeze.reason}
          </p>
        )}
        <label>
          Lý do{' '}
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} data-testid="freeze-reason" />
        </label>
        <div className="row">
          {!frozen && hasRole(me, 'operator', 'owner') && (
            <button data-testid="freeze" onClick={() => void run('Bật khóa ghi', () => api('/api/ops/freeze', { method: 'POST', body: { reason: reason || 'Bật thủ công từ UI' } }))}>
              Bật khóa ghi
            </button>
          )}
          {frozen && hasRole(me, 'owner') && (
            <>
              <label>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="ack-unresolved" /> Tôi đã xử lý thủ công các proposal UNKNOWN/NEEDS_REVIEW
              </label>
              <button data-testid="unfreeze" onClick={() => void run('Mở lại ghi', () => api('/api/ops/unfreeze', { method: 'POST', body: { reason: reason || 'Owner mở lại sau khi đối soát', acknowledge_unresolved: ack } }))}>
                Mở lại ghi (chỉ owner)
              </button>
            </>
          )}
          {frozen && !hasRole(me, 'owner') && <span className="muted">Chỉ owner mở lại được.</span>}
        </div>
        {msg && (
          <p className="note" role="status" data-testid="ops-result">
            {msg}
          </p>
        )}
      </section>

      {health && (
        <section className="card">
          <h2>Sức khỏe</h2>
          <dl>
            <dt>Mode</dt>
            <dd>
              {health.mode}, LIVE_WRITES_ENABLED={String(health.live_writes_enabled)}
            </dd>
            <dt>Chờ duyệt / xếp hàng</dt>
            <dd>
              {health.pending_approval} / {health.queued_jobs}
            </dd>
            <dt>UNKNOWN / cần xem</dt>
            <dd className={health.unknown_or_review ? 'error' : ''}>{health.unknown_or_review}</dd>
            <dt>Chuỗi audit</dt>
            <dd>{health.audit_chain.ok ? `hợp lệ (${health.audit_chain.events})` : `HỎNG tại #${health.audit_chain.broken_at}`}</dd>
          </dl>
        </section>
      )}

      {hasRole(me, 'analyst', 'operator', 'owner') && (
        <section className="card">
          <h2>Ghi nhận sự cố</h2>
          <div className="row">
            <select value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])} data-testid="incident-kind">
              {KINDS.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
            <input placeholder="Mô tả (không dán token/mật khẩu)" value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={1000} data-testid="incident-detail" />
            <button data-testid="incident-create" onClick={() => void run('Tạo incident', () => api('/api/ops/incidents', { method: 'POST', body: { kind, detail: detail || kind, request_freeze: true } }))}>
              Tạo incident + khóa ghi
            </button>
          </div>
        </section>
      )}

      <section className="card">
        <h2>Incidents</h2>
        {incidents.length === 0 ? (
          <p className="muted">Không có incident.</p>
        ) : (
          <table data-testid="incidents">
            <thead>
              <tr>
                <th>ID</th>
                <th>Mức</th>
                <th>Trạng thái</th>
                <th>Phát hiện</th>
                <th>Thành phần</th>
                <th>Bằng chứng</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((i) => (
                <tr key={i.incident_id}>
                  <td>{i.incident_id}</td>
                  <td>{i.severity}</td>
                  <td>{i.state}</td>
                  <td>
                    <Time iso={i.detected_at} />
                  </td>
                  <td>{i.affected_scope.components.join(', ')}</td>
                  <td className="untrusted">{i.evidence.map((e) => e.note).join('; ')}</td>
                  <td>
                    {i.state !== 'resolved' && hasRole(me, 'operator', 'owner') && (
                      <button className="secondary" onClick={() => void run('Đóng incident', () => api(`/api/ops/incidents/${i.incident_id}/resolve`, { method: 'POST', body: { resolution: 'Đã xử lý (ghi từ UI)' } }))}>
                        Đóng
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">Đóng incident không tự mở khóa ghi. Mở khóa là bước riêng của owner.</p>
      </section>
    </>
  );
}
