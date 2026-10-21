'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useSession } from './session';

/** Mode/account banner shown on every page. It must never look like "live" when it is not. */
export function Banner() {
  const { status, me } = useSession();
  if (!status || !me) return null;
  const live = status.mode !== 'mock' && status.live_writes_enabled;
  return (
    <div className={`banner ${live ? 'banner-live' : 'banner-mock'}`} data-testid="mode-banner">
      <strong>{status.mode === 'mock' ? 'MOCK — dữ liệu mô phỏng, không gọi Meta thật' : `MODE: ${status.mode}`}</strong>
      <span>LIVE_WRITES_ENABLED={String(status.live_writes_enabled)}</span>
      <span>Adapter Meta: {status.meta_adapter}</span>
      <span>Tenant: {status.tenant_id}</span>
      <span data-testid="freeze-indicator" className={status.freeze.frozen ? 'pill pill-red' : 'pill'}>
        Khóa ghi nội bộ: {status.freeze.frozen ? 'ĐANG BẬT' : 'tắt'}
      </span>
      {status.freeze.frozen && <span className="banner-note">{status.running_ads_note}</span>}
    </div>
  );
}

const NAV = [
  { href: '/', label: 'Tổng quan' },
  { href: '/ops', label: 'Vận hành & sự cố' },
  { href: '/audit', label: 'Audit' },
];

export function Shell({ children }: { children: ReactNode }) {
  const { me, logout } = useSession();
  const path = usePathname();
  return (
    <>
      <Banner />
      <header className="top">
        <span className="brand">POD AI Ads Manager</span>
        <nav>
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={path === n.href ? 'active' : ''}>
              {n.label}
            </Link>
          ))}
        </nav>
        <span className="who">
          {me?.display_name} ({me?.grants.map((g) => g.role).join(', ')})
          <button className="link" onClick={logout} data-testid="logout">
            Đăng xuất
          </button>
        </span>
      </header>
      <main className="page">{children}</main>
    </>
  );
}
