'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, Package, Truck, Receipt, ShoppingBag, ClipboardCheck, CheckCheck } from 'lucide-react';
import { useNotifications, type AppNotification } from '@/hooks/use-notifications';
import { formatRelativeTime } from '@/lib/format';

const typeStyles: Record<string, { icon: React.ElementType; color: string }> = {
  low_stock: { icon: Package, color: 'text-amber-600 bg-amber-50' },
  new_order: { icon: ShoppingBag, color: 'text-indigo-600 bg-indigo-50' },
  payment_received: { icon: Receipt, color: 'text-green-600 bg-green-50' },
  delivery_update: { icon: Truck, color: 'text-pink-600 bg-pink-50' },
  po_approval: { icon: ClipboardCheck, color: 'text-purple-600 bg-purple-50' },
};

function NotificationRow({ n, unread, onOpen }: { n: AppNotification; unread: boolean; onOpen: (n: AppNotification) => void }) {
  const style = typeStyles[n.type] || { icon: Bell, color: 'text-muted-foreground bg-muted' };
  return (
    <button
      onClick={() => onOpen(n)}
      className="w-full flex items-start gap-3 px-3 py-2.5 hover:bg-muted/50 transition-colors border-b border-border/50 last:border-0 text-left"
    >
      <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${style.color}`}>
        <style.icon className="w-3.5 h-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm leading-snug break-words ${unread ? 'font-semibold text-foreground' : 'text-foreground/80'}`}>
          {n.title}
        </p>
        {n.body && <p className="text-xs text-muted-foreground mt-0.5 break-words">{n.body}</p>}
        <p className="text-[10px] text-muted-foreground mt-1">{formatRelativeTime(n.created_at)}</p>
      </div>
      {unread && <span className="w-2 h-2 rounded-full bg-blue-600 shrink-0 mt-1.5" />}
    </button>
  );
}

export default function NotificationBell() {
  const router = useRouter();
  const { notifications, unreadCount, readIds, loading, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function handleOpen(n: AppNotification) {
    setOpen(false);
    if (unreadCount > 0) markRead(n.id);
    if (n.href) router.push(n.href);
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Notifications"
        className="relative w-8 h-8 flex items-center justify-center rounded-lg hover:bg-muted transition-colors"
      >
        <Bell className="w-4 h-4 text-muted-foreground" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-80 bg-white border border-border rounded-xl shadow-lg z-50 animate-fade-in overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
            <span className="text-sm font-semibold">Notifications</span>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium"
              >
                <CheckCheck className="w-3.5 h-3.5" />Mark all read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {loading ? (
              <div className="px-3 py-4 text-xs text-muted-foreground">Loading…</div>
            ) : notifications.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                No notifications yet. Alerts about payments, deliveries, stock and purchase orders will appear here.
              </div>
            ) : (
              notifications.map(n => (
                <NotificationRow key={n.id} n={n} unread={!readIds.has(n.id)} onOpen={handleOpen} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
