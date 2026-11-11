import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
export const metadata: Metadata = { title: 'GHN Shipping', description: 'Dịch vụ vận chuyển GHN độc lập' };
export default function RootLayout({ children }: { children: ReactNode }) {
 return <html lang="vi"><body>{children}</body></html>;
}
