'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, type AuditEvent } from '../../lib/api';
import { Time } from '../../components/format';

export default function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<{ events: AuditEvent[] }>('/api/audit')
      .then((r) => setEvents(r.events))
      .catch((e: Error) => setErr(e.message));
  }, []);
  if (err) return <p className="error">{err}</p>;
  if (!events) return <p className="muted">Đang tải…</p>;
  return (
    <>
      <h1>Audit (200 sự kiện gần nhất)</h1>
      <p className="muted">Append-only, nối chuỗi hash theo tenant. Chỉ lưu tóm tắt và hash payload, không lưu token hay PII.</p>
      <table data-testid="audit-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Lúc</th>
            <th>Người/hệ thống</th>
            <th>Sự kiện</th>
            <th>Liên quan</th>
            <th>Tóm tắt</th>
            <th>Hash</th>
          </tr>
        </thead>
        <tbody>
          {[...events].reverse().map((e) => (
            <tr key={e.sequence}>
              <td>{e.sequence}</td>
              <td>
                <Time iso={e.occurred_at} />
              </td>
              <td>
                {e.actor_id} ({e.actor_kind})
              </td>
              <td>
                <code>{e.event_type}</code>
              </td>
              <td>{e.correlation_id.startsWith('prp_') ? <Link href={`/proposals/${e.correlation_id}`}>{e.correlation_id}</Link> : e.correlation_id}</td>
              <td>{e.summary}</td>
              <td className="mono">{e.event_hash.slice(0, 12)}…</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
