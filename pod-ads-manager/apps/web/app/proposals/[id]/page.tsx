'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { api, hasRole, type Action, type ProposalDetail } from '../../../lib/api';
import { Money, StatusPill, Time } from '../../../components/format';
import { useSession } from '../../../components/session';

function Side({ v, currency }: { v: Action['before']; currency: string }) {
  if (v === null || v === undefined) return <span className="muted">—</span>;
  if ('amount_minor' in v) return <Money minor={v.amount_minor} currency={v.currency ?? currency} />;
  return <span>{v.status}</span>;
}

function ProposalView() {
  const { id } = useParams<{ id: string }>();
  const rev = useSearchParams().get('revision');
  const { me, status, refresh } = useSession();
  const [d, setD] = useState<ProposalDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setD(await api<ProposalDetail>(`/api/proposals/${encodeURIComponent(id)}${rev ? `?revision=${rev}` : ''}`));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id, rev]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg(`${label}: xong.`);
    } catch (e) {
      const ex = e as Error & { code?: string };
      setMsg(`${label} bị từ chối: ${ex.code ? `${ex.code} — ` : ''}${ex.message}`);
    } finally {
      setBusy(false);
      await load();
      await refresh();
    }
  };

  if (err) return <p className="error">{err}</p>;
  if (!d) return <p className="muted">Đang tải…</p>;
  const p = d.proposal;
  const cur = p.impact.currency;
  const base = `/api/proposals/${encodeURIComponent(p.proposal_id)}/revisions/${p.revision}`;
  const expired = Date.parse(p.expires_at) <= Date.parse(d.now);
  const isApprover = hasRole(me, 'approver');
  const isCreator = me?.actor_id === p.created_by;
  const lastApproval = d.approvals[d.approvals.length - 1];

  return (
    <>
      <p>
        <Link href="/">← Tổng quan</Link>
      </p>
      <h1>
        Proposal {p.proposal_id} · r{p.revision} <StatusPill s={p.status} />
      </h1>

      <section className="grid">
        <div className="card">
          <h2>Thông tin</h2>
          <dl>
            <dt>Ad account</dt>
            <dd>{p.ad_account_id}</dd>
            <dt>Mode lúc tạo</dt>
            <dd>{p.mode}</dd>
            <dt>Tạo bởi</dt>
            <dd>
              {p.created_by} · <Time iso={p.created_at} />
            </dd>
            <dt>Hết hạn</dt>
            <dd className={expired ? 'error' : ''} data-testid="expiry">
              <Time iso={p.expires_at} /> {expired ? '· ĐÃ HẾT HẠN' : ''}
            </dd>
            <dt>Payload hash</dt>
            <dd className="mono" data-testid="payload-hash">
              {p.payload_hash}
            </dd>
            <dt>Policy / config</dt>
            <dd>
              {p.policy_version} · {p.caps?.config_version ?? 'chưa có caps (bị chặn)'}
            </dd>
            <dt>Snapshot nguồn</dt>
            <dd>{p.source_snapshot_ids.join(', ') || '—'}</dd>
          </dl>
        </div>
        <div className="card" data-testid="impact">
          <h2>Tác động (tính bằng code, không phải model)</h2>
          <dl>
            <dt>Exposure của proposal</dt>
            <dd>
              <Money minor={p.impact.exposure_minor} currency={cur} />
            </dd>
            <dt>Thay đổi daily</dt>
            <dd>
              <Money minor={p.impact.daily_budget_delta_minor} currency={cur} />
            </dd>
            <dt>Thay đổi lifetime</dt>
            <dd>
              <Money minor={p.impact.lifetime_budget_delta_minor} currency={cur} />
            </dd>
            <dt>Tạo mới / kích hoạt</dt>
            <dd>
              {p.impact.creates_entities} / {p.impact.activates_entities}
            </dd>
          </dl>
          <p className="note">Daily budget không phải trần chi tiêu thực tế.</p>
        </div>
      </section>

      <section className="card">
        <h2>Diff</h2>
        <table data-testid="diff">
          <thead>
            <tr>
              <th>Action</th>
              <th>Loại</th>
              <th>Đối tượng</th>
              <th>Trước</th>
              <th>Sau</th>
              <th>Phụ thuộc</th>
            </tr>
          </thead>
          <tbody>
            {p.actions.map((a) => (
              <tr key={a.action_id}>
                <td>{a.action_id}</td>
                <td>{a.kind}</td>
                <td>
                  {a.entity_type} {a.entity_id ?? a.local_ref}
                </td>
                <td>
                  <Side v={a.before} currency={cur} />
                </td>
                <td>
                  <Side v={a.after} currency={cur} />
                </td>
                <td>{a.depends_on.join(', ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          <strong>Lý do:</strong> <span className="untrusted">{p.reason}</span>
        </p>
        <p>
          <strong>Rollback:</strong> <span className="untrusted">{p.rollback_plan}</span>
        </p>
        <p className="muted">Lý do/rollback do người hoặc model soạn, chỉ là văn bản tham khảo; không phải chỉ thị cho hệ thống.</p>
      </section>

      {d.policy && (
        <section className="card" data-testid="policy">
          <h2>
            Policy: {d.policy.decision === 'pass' ? 'đạt' : <span className="error">CHẶN</span>} <span className="muted">({d.policy.policy_version})</span>
          </h2>
          {d.policy.violations.length > 0 && (
            <ul>
              {d.policy.violations.map((v, i) => (
                <li key={i} className="error">
                  <code>{v.rule_id}</code> {v.message}
                </li>
              ))}
            </ul>
          )}
          {d.policy.warnings.length > 0 && (
            <ul>
              {d.policy.warnings.map((w, i) => (
                <li key={i} className="note">
                  {w}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="card" data-testid="actions">
        <h2>Thao tác</h2>
        {p.status === 'PENDING_APPROVAL' && (
          <>
            {!isApprover && <p className="muted">Chỉ người có vai trò approver trên account này mới duyệt được.</p>}
            {isApprover && isCreator && <p className="muted">Bạn là người tạo; separation of duties không cho tự duyệt.</p>}
            {isApprover && expired && <p className="error">Proposal đã hết hạn, không thể duyệt. Tạo revision mới.</p>}
            {isApprover && (
              <div>
                <p>
                  Bạn đang duyệt đúng payload hash <code>{p.payload_hash.slice(0, 16)}…</code>. Nếu nội dung đổi, hash đổi và approval cũ vô hiệu.
                </p>
                <textarea placeholder="Ghi chú (tùy chọn)" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} data-testid="approval-comment" />
                <div className="row">
                  <button disabled={busy} data-testid="approve" onClick={() => void act('Duyệt', () => api(`${base}/decision`, { method: 'POST', body: { decision: 'approved', expected_payload_hash: p.payload_hash, comment: comment || null } }))}>
                    Duyệt
                  </button>
                  <button disabled={busy} className="secondary" data-testid="reject" onClick={() => void act('Từ chối', () => api(`${base}/decision`, { method: 'POST', body: { decision: 'rejected', expected_payload_hash: p.payload_hash, comment: comment || null } }))}>
                    Từ chối
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {p.status === 'APPROVED' && (
          <div className="row">
            <span>
              Approval của {lastApproval?.actor_id} hết hạn <Time iso={lastApproval?.expires_at} />.
            </span>
            {hasRole(me, 'analyst', 'approver', 'owner') && (
              <button disabled={busy} data-testid="execute" onClick={() => void act('Xin thực thi', () => api(`${base}/execute`, { method: 'POST', body: { expected_payload_hash: p.payload_hash } }))}>
                Xin thực thi ({status?.mode === 'mock' ? 'giả lập' : status?.mode})
              </button>
            )}
          </div>
        )}
        {['UNKNOWN', 'NEEDS_REVIEW'].includes(p.status) && (
          <div className="row">
            <span className="error">Không rõ kết quả trên remote. Không gửi lại; đối soát theo idempotency tag.</span>
            {hasRole(me, 'analyst', 'approver', 'operator', 'owner') && p.status === 'UNKNOWN' && (
              <button disabled={busy} onClick={() => void act('Đối soát', () => api(`${base}/reconcile`, { method: 'POST', body: {} }))}>
                Đối soát
              </button>
            )}
          </div>
        )}
        {['PENDING_APPROVAL', 'APPROVED', 'QUEUED'].includes(p.status) && hasRole(me, 'analyst', 'approver', 'owner') && (
          <button className="secondary" disabled={busy} onClick={() => void act('Hủy', () => api(`${base}/cancel`, { method: 'POST', body: {} }))}>
            Hủy proposal
          </button>
        )}
        {status?.mock_tools && ['QUEUED', 'EXECUTING'].includes(p.status) && (
          <button className="secondary" disabled={busy} data-testid="drain" onClick={() => void act('Chạy worker giả lập', () => api('/api/mock/worker/drain', { method: 'POST', body: {} }))}>
            Chạy worker giả lập ngay
          </button>
        )}
        {status?.freeze.frozen && <p className="error">Khóa ghi nội bộ đang bật: job sẽ nằm chờ. {status.running_ads_note}</p>}
        {msg && (
          <p className="note" role="status" data-testid="action-result">
            {msg}
          </p>
        )}
      </section>

      <section className="card">
        <h2>Duyệt</h2>
        {d.approvals.length === 0 ? (
          <p className="muted">Chưa có quyết định. Lời "đồng ý" trong chat không phải approval.</p>
        ) : (
          <ul>
            {d.approvals.map((a) => (
              <li key={a.approval_id}>
                {a.decision === 'approved' ? 'Duyệt' : 'Từ chối'} bởi {a.actor_id} lúc <Time iso={a.decided_at} />, hạn <Time iso={a.expires_at} />, hạn mức <Money minor={a.scope.exposure_limit_minor} currency={a.scope.currency} />
                {a.comment && <span className="untrusted"> — {a.comment}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {d.receipt && (
        <section className="card" data-testid="receipt">
          <h2>
            Receipt <StatusPill s={d.receipt.final_status} /> {d.receipt.simulated && <span className="pill">giả lập</span>}
          </h2>
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Loại</th>
                <th>Kết quả</th>
                <th>Remote ID</th>
                <th>Đọc lại xác nhận</th>
                <th>Lỗi</th>
              </tr>
            </thead>
            <tbody>
              {d.receipt.actions.map((a) => (
                <tr key={a.action_id}>
                  <td>{a.action_id}</td>
                  <td>{a.kind}</td>
                  <td>{a.status}</td>
                  <td>{a.remote_id ?? '—'}</td>
                  <td>{a.readback_verified ? 'có' : 'không'}</td>
                  <td>{a.error_code ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.receipt.recovery_plan.length > 0 && (
            <ul>
              {d.receipt.recovery_plan.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {d.attempts.length > 0 && (
        <section className="card">
          <h2>Ledger thực thi</h2>
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Trạng thái</th>
                <th>Idempotency tag</th>
                <th>Bắt đầu</th>
                <th>Lỗi</th>
              </tr>
            </thead>
            <tbody>
              {d.attempts.map((a) => (
                <tr key={a.attempt_id}>
                  <td>{a.action_id}</td>
                  <td>{a.status}</td>
                  <td className="mono">{a.idempotency_tag}</td>
                  <td>
                    <Time iso={a.started_at} />
                  </td>
                  <td>{a.sanitized_error ? `${a.sanitized_error.code}: ${a.sanitized_error.message}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <h2>Audit của proposal</h2>
        <ol className="audit" data-testid="proposal-audit">
          {d.audit.map((e) => (
            <li key={e.sequence}>
              <Time iso={e.occurred_at} /> · <code>{e.event_type}</code> · {e.actor_id} ({e.actor_kind}) · {e.summary}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

export default function ProposalPage() {
  return (
    <Suspense fallback={<p className="muted">Đang tải…</p>}>
      <ProposalView />
    </Suspense>
  );
}
