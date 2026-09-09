import './globals.css';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import ServiceWorkerRegistrar from '@/components/offline/ServiceWorkerRegistrar';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'SI Building Solutions ERP',
  description: 'Complete ERP system for SI Building Solutions — manage inventory, sales, CRM, projects, and more.',
  manifest: '/manifest.json',
  icons: {
    icon: '/icon-192.png',
    apple: '/icon-192.png',
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
