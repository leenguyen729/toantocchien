import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SessionProvider } from '../components/session';
import { Shell } from '../components/shell';
import './globals.css';

export const metadata: Metadata = { title: 'POD AI Ads Manager', description: 'Quản lý đề xuất quảng cáo có duyệt của con người (mock mode)' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body>
        <SessionProvider>
          <Shell>{children}</Shell>
        </SessionProvider>
      </body>
    </html>
  );
}
