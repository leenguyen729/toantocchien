'use client';

import { formatMinor } from '@pod/contracts/currency';

/** Display-only money. Never parse this back into numbers. */
export function Money({ minor, currency }: { minor: number | null | undefined; currency: string }) {
  if (minor === null || minor === undefined) return <span className="muted">chưa khai báo</span>;
  try {
    return <span className="num">{formatMinor(minor, currency)}</span>;
  } catch {
    return <span className="error">{minor} (tiền tệ {currency} chưa hỗ trợ)</span>;
  }
}

export function Time({ iso, tz }: { iso: string | null | undefined; tz?: string }) {
  if (!iso) return <span className="muted">—</span>;
  const d = new Date(iso);
  const text = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'medium', timeZone: tz ?? 'UTC' }).format(d);
  return (
    <time dateTime={iso} title={iso}>
      {text} {tz ?? 'UTC'}
    </time>
  );
}

const STATUS_VI: Record<string, string> = {
  DRAFT: 'Nháp (bị chặn)',
  VALIDATED: 'Đã kiểm tra',
  PENDING_APPROVAL: 'Chờ duyệt',
  APPROVED: 'Đã duyệt',
  REJECTED: 'Từ chối',
  EXPIRED: 'Hết hạn',
  CANCELLED: 'Đã hủy',
  INVALIDATED: 'Không còn hợp lệ',
  QUEUED: 'Đang xếp hàng',
  EXECUTING: 'Đang thực thi',
  SUCCEEDED: 'Thành công',
  PARTIAL: 'Một phần',
  FAILED: 'Thất bại',
  UNKNOWN: 'Không rõ kết quả',
  RECONCILING: 'Đang đối soát',
  NEEDS_REVIEW: 'Cần người xem',
};
const TONE: Record<string, string> = { SUCCEEDED: 'green', PENDING_APPROVAL: 'amber', APPROVED: 'blue', QUEUED: 'blue', UNKNOWN: 'red', NEEDS_REVIEW: 'red', FAILED: 'red', PARTIAL: 'red', DRAFT: 'grey' };

export function StatusPill({ s }: { s: string }) {
  return (
    <span className={`pill pill-${TONE[s] ?? 'grey'}`} data-testid="status-pill" data-status={s}>
      {STATUS_VI[s] ?? s}
    </span>
  );
}
