'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import Sidebar from '@/components/layout/Sidebar';
import Header from '@/components/layout/Header';
import QuickActionDrawer from '@/components/ui/QuickActionDrawer';
import { Toaster } from '@/components/ui/toaster';
import { Menu, PanelLeftClose, PanelLeft } from 'lucide-react';

export default function ERPLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('sidebarCollapsed');
    if (saved) setSidebarCollapsed(saved === 'true');
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        router.replace('/login');
      } else {
        setLoading(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        router.replace('/login');
      }
    });

    return () => subscription.unsubscribe();
  }, [router]);

  function toggleSidebarCollapsed() {
    setSidebarCollapsed(prev => {
      const newValue = !prev;
      localStorage.setItem('sidebarCollapsed', String(newValue));
      return newValue;
    });
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-slate-400 text-sm">Loading ERP...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-background">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar — hidden on mobile, collapsible on lg+ */}
      <div className={`
        fixed inset-y-0 left-0 z-50 lg:relative lg:z-auto
        transform transition-all duration-300 ease-in-out
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        ${sidebarCollapsed ? 'lg:w-[60px]' : 'lg:w-auto'}
      `}>
        <Sidebar collapsed={sidebarCollapsed} />
      </div>

      {/* Collapse toggle button - desktop only */}
      <button
        onClick={toggleSidebarCollapsed}
        className="hidden lg:flex fixed left-0 top-1/2 -translate-y-1/2 z-30 w-5 h-12 items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors rounded-r-lg"
        style={{ left: sidebarCollapsed ? '60px' : '220px' }}
        title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {sidebarCollapsed ? <PanelLeft className="w-3.5 h-3.5" /> : <PanelLeftClose className="w-3.5 h-3.5" />}
      </button>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile menu button - fixed position */}
        <div className="lg:hidden fixed top-0 left-0 right-0 z-30 flex items-center gap-2 px-4 py-3 bg-slate-900/95 backdrop-blur-sm border-b border-slate-800">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-white p-2 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors"
          >
            <Menu className="w-5 h-5" />
          </button>
          <span className="text-white font-bold text-sm tracking-tight">SI Building ERP</span>
        </div>
        {/* Spacer for mobile fixed header */}
        <div className="lg:hidden h-14" />

        <Header onMenuToggle={() => setSidebarOpen(!sidebarOpen)} />

        <main className="flex-1 overflow-auto p-4 md:p-6 animate-fade-in">
          {children}
        </main>
      </div>

      {/* Global Quick Action Drawer */}
      <QuickActionDrawer />
      <Toaster />
    </div>
  );
}
