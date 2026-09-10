import './globals.css';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import ServiceWorkerRegistrar from '@/components/offline/ServiceWorkerRegistrar';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'SI Building Solutions ERP',
  description: 'Complete ERP system for SI Building Solutions — manage inventory, sales, CRM, projects, and more.',
  manifest: '/manifest.json',
  themeColor: '#0f172a',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '48x48' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    // 'default' keeps a normal status bar — 'black-translucent' would need
    // viewport-fit=cover + safe-area padding across the whole ERP layout.
    statusBarStyle: 'default',
    title: 'SI ERP',
  },
  other: {
    // Chrome's unprefixed replacement for apple-mobile-web-app-capable.
    'mobile-web-app-capable': 'yes',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans antialiased`}>
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
