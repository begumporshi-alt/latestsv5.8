'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  entity_type: string | null;
  entity_id: string | null;
  href: string | null;
  created_at: string;
}

const PAGE_SIZE = 50;

export function useNotifications() {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const userIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }
    userIdRef.current = user.id;

    const [notifRes, readsRes] = await Promise.all([
      supabase
        .from('notifications')
        .select('id, type, title, body, entity_type, entity_id, href, created_at')
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE),
      supabase
        .from('notification_reads')
        .select('notification_id')
        .eq('user_id', user.id),
    ]);

    if (notifRes.data) setNotifications(notifRes.data);
    if (readsRes.data) setReadIds(new Set(readsRes.data.map(r => r.notification_id)));
    setLoading(false);
  }, []);

  useEffect(() => {
    load();

    const channel = supabase
      .channel('notifications')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications' },
        (payload) => {
          const row = payload.new as AppNotification;
          setNotifications(prev =>
            prev.some(n => n.id === row.id) ? prev : [row, ...prev].slice(0, PAGE_SIZE)
          );
        }
      )
      .subscribe();

    // Realtime only works online — poll as a fallback so the badge
    // still advances when the socket is down.
    const poll = setInterval(load, 60_000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(poll);
    };
  }, [load]);

  const markRead = useCallback(async (notificationId: string) => {
    const uid = userIdRef.current;
    if (!uid) return;
    setReadIds(prev => {
      if (prev.has(notificationId)) return prev;
      const next = new Set(prev);
      next.add(notificationId);
      return next;
    });
    await supabase
      .from('notification_reads')
      .upsert(
        { notification_id: notificationId, user_id: uid },
        { onConflict: 'notification_id,user_id', ignoreDuplicates: true }
      );
  }, []);

  const markAllRead = useCallback(async () => {
    const uid = userIdRef.current;
    if (!uid) return;
    const unread = notifications.filter(n => !readIds.has(n.id));
    if (unread.length === 0) return;
    setReadIds(prev => {
      const next = new Set(prev);
      unread.forEach(n => next.add(n.id));
      return next;
    });
    await supabase.from('notification_reads').upsert(
      unread.map(n => ({ notification_id: n.id, user_id: uid })),
      { onConflict: 'notification_id,user_id', ignoreDuplicates: true }
    );
  }, [notifications, readIds]);

  const unreadCount = notifications.filter(n => !readIds.has(n.id)).length;

  return { notifications, unreadCount, readIds, loading, markRead, markAllRead, reload: load };
}
