'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, hasRole, type Dashboard, type Proposal } from '../lib/api';
import { Money, StatusPill, Time } from '../components/format';
import { useSession } from '../components/session';

export default function DashboardPage() {
  const { me, status } = useSession();
  const [d, setD] = useState<Dashboard | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [entity, setEntity] = useState('adset_demo');
  const [amount, setAmount] = useState('1100');

  const load = useCallback(async () => {
    try {
      const [dash, list] = await Promise.all([api<Dashboard>('/api/dashboard'), api<{ proposals: Proposal[] }>('/api/proposals')]);
      setD(dash);
      setProposals(list.proposals);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const draft = async () => {
    setMsg(null);
    const n = Number(amount);
    if (!Number.isInteger(n) || n < 0) return setMsg('Budget mới phải là số nguyên minor unit (ví dụ 1100 = 11.00 USD).');
    try {
      const r = await api<{ status: string; data: { proposal_id: string; status: string } | null; errors: { code: string; message: string }[] }>('/api/mock/analyst/draft', {
        method: 'POST',
        body: { entity_id: entity, new_daily_budget_minor: n },
      });
      if (r.status !== 'ok' || !r.data) setMsg(`Mock analyst không tạo được: ${r.errors.map((e) => `${e.code}: ${e.message}`).join('; ')}`);
      else setMsg(`Đã tạo proposal ${r.data.proposal_id} (${r.data.status}). Proposal chỉ là đề xuất, cần người duyệt.`);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  if (err) return <p className="error">{err}</p>;
  if (!d) return <p className="muted">Đang tải…</p>;
  const cfg = d.config;
  const cur = cfg?.account_currency ?? 'USD';
  const budgetEntities = d.remote.entities.filter((e) => e.daily_budget_minor !== null);

  return (
    <>
      <h1>Tổng quan · {d.ad_account_id}</h1>

      <section className="grid">
        <div className="card" data-testid="config-card">
          <h2>Cấu hình kinh doanh</h2>
          {!cfg ? (
            <p className="error">Chưa có config. Mọi thao tác ghi bị chặn.</p>
          ) : (
            <dl>
              <dt>Version</dt>
              <dd>
                {cfg.version} · {cfg.status === 'confirmed' ? `owner đã xác nhận (${cfg.confirmed_by})` : <span className="error">bản nháp chưa xác nhận: ghi bị chặn</span>}
              </dd>
              <dt>Tiền tệ</dt>
              <dd>
                account {cfg.account_currency} · store {cfg.store_currency}
              </dd>
              <dt>Timezone</dt>
              <dd>
                báo cáo {cfg.reporting_timezone} · account {cfg.account_timezone}
              </dd>
              <dt>Trần daily (tổng account)</dt>
              <dd>
                <Money minor={cfg.caps.daily_budget_cap_minor} currency={cur} />
              </dd>
              <dt>Trần lifetime</dt>
              <dd>
                <Money minor={cfg.caps.lifetime_budget_cap_minor} currency={cur} />
              </dd>
              <dt>Exposure tối đa / proposal</dt>
              <dd>
                <Money minor={cfg.caps.proposal_exposure_cap_minor} currency={cur} />
              </dd>
              <dt>Mỗi lần đổi</dt>
              <dd>
                ≤ {cfg.max_change_pct === null ? '—' : `${Math.round(cfg.max_change_pct * 100)}%`} và ≤ <Money minor={cfg.max_change_amount_minor} currency={cur} />; cooldown {cfg.cooldown_seconds ?? '—'}s; TTL duyệt {cfg.approval_ttl_seconds ?? '—'}s
              </dd>
            </dl>
          )}
          <p className="note">Daily budget không phải trần chi tiêu tuyệt đối: Meta có thể chi lệch trong ngày. Trần ở đây là kiểm soát nội bộ của hệ thống.</p>
        </div>

        <div className="card" data-testid="health-card">
          <h2>Sức khỏe</h2>
          {d.health ? (
            <dl>
              <dt>Chờ duyệt</dt>
              <dd>{d.health.pending_approval}</dd>
              <dt>Job đang xếp hàng</dt>
              <dd>{d.health.queued_jobs}</dd>
              <dt>UNKNOWN / cần xem</dt>
              <dd className={d.health.unknown_or_review > 0 ? 'error' : ''}>{d.health.unknown_or_review}</dd>
              <dt>Incident mở</dt>
              <dd>{d.health.open_incidents}</dd>
              <dt>Chuỗi audit</dt>
              <dd>{d.health.audit_chain.ok ? `hợp lệ (${d.health.audit_chain.events} sự kiện)` : `HỎNG tại #${d.health.audit_chain.broken_at}`}</dd>
            </dl>
          ) : (
            <p className="muted">Vai trò của bạn không xem được sức khỏe hệ thống.</p>
          )}
        </div>
      </section>

      <section className="card">
        <h2>Dữ liệu nguồn</h2>
        <table data-testid="snapshots">
          <thead>
            <tr>
              <th>Snapshot</th>
              <th>Nguồn</th>
              <th>API version</th>
              <th>Lấy lúc</th>
              <th>Kỳ</th>
              <th>Timezone</th>
              <th>Tiền tệ</th>
              <th>Attribution</th>
              <th>Đầy đủ</th>
            </tr>
          </thead>
          <tbody>
            {d.snapshots.map((s) => (
              <tr key={s.snapshot_id}>
                <td>{s.snapshot_id}</td>
                <td>{s.source}</td>
                <td>{s.api_version}</td>
                <td>
                  <Time iso={s.fetched_at} tz={cfg?.reporting_timezone} />
                </td>
                <td>
                  {s.range.since} → {s.range.until}
                </td>
                <td>{s.timezone}</td>
                <td>{s.currency}</td>
                <td>{s.attribution}</td>
                <td className={s.completeness === 'complete' ? '' : 'error'}>
                  {s.completeness}
                  {s.missing_fields.length > 0 && ` (thiếu ${s.missing_fields.join(', ')})`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>
          Cấu trúc remote <span className="muted">· nguồn {d.remote.source}, đọc lúc <Time iso={d.remote.fetched_at} tz={cfg?.reporting_timezone} /></span>
        </h2>
        <table data-testid="entities">
          <thead>
            <tr>
              <th>ID</th>
              <th>Loại</th>
              <th>Tên</th>
              <th>Trạng thái</th>
              <th>Daily</th>
              <th>Lifetime</th>
            </tr>
          </thead>
          <tbody>
            {d.remote.entities.map((e) => (
              <tr key={e.entity_id}>
                <td>{e.entity_id}</td>
                <td>{e.entity_type}</td>
                <td>{e.name}</td>
                <td>{e.status}</td>
                <td>{e.daily_budget_minor === null ? '—' : <Money minor={e.daily_budget_minor} currency={e.currency} />}</td>
                <td>{e.lifetime_budget_minor === null ? '—' : <Money minor={e.lifetime_budget_minor} currency={e.currency} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {status?.mock_tools && hasRole(me, 'analyst', 'owner') && (
        <section className="card">
          <h2>Mock analyst (giả lập Claude, không gọi API)</h2>
          <p className="muted">Chạy qua đúng tool layer và principal của Claude runtime. Kết quả chỉ là proposal chờ duyệt.</p>
          <div className="row">
            <label>
              Đối tượng{' '}
              <select value={entity} onChange={(e) => setEntity(e.target.value)} data-testid="draft-entity">
                {budgetEntities.map((e) => (
                  <option key={e.entity_id} value={e.entity_id}>
                    {e.entity_id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Daily budget mới (minor, {cur}){' '}
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" data-testid="draft-amount" />
            </label>
            <button onClick={() => void draft()} data-testid="draft-submit">
              Soạn proposal
            </button>
          </div>
          {msg && (
            <p className="note" data-testid="draft-result">
              {msg}
            </p>
          )}
        </section>
      )}

      <section className="card">
        <h2>Proposals</h2>
        {proposals.length === 0 ? (
          <p className="muted">Chưa có proposal.</p>
        ) : (
          <table data-testid="proposals">
            <thead>
              <tr>
                <th>ID</th>
                <th>Rev</th>
                <th>Trạng thái</th>
                <th>Exposure</th>
                <th>Tạo bởi</th>
                <th>Hết hạn</th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((p) => (
                <tr key={`${p.proposal_id}-${p.revision}`}>
                  <td>
                    <Link href={`/proposals/${p.proposal_id}?revision=${p.revision}`} data-testid="proposal-link">
                      {p.proposal_id}
                    </Link>
                  </td>
                  <td>r{p.revision}</td>
                  <td>
                    <StatusPill s={p.status} />
                  </td>
                  <td>
                    <Money minor={p.impact.exposure_minor} currency={p.impact.currency} />
                  </td>
                  <td>{p.created_by}</td>
                  <td>
                    <Time iso={p.expires_at} tz={cfg?.reporting_timezone} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
