'use client';

/**
 * React bindings for the offline layer.
 *
 * OfflineProvider mounts the network monitor and the sync engine exactly
 * once (in the ERP layout) and exposes their state to any component:
 *
 *   const { online, engine, counts, syncNow } = useOffline()
 *
 * Components outside a provider get a benign default (online, idle) so the
 * hook is safe to call anywhere.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { networkMonitor } from './network';
import { syncEngine, type SyncEngineState } from './sync';
import { outboxCounts, subscribeOutbox, type OutboxCounts } from './outbox';
import { startReplicator, subscribeReplica } from './replica';
import { startWarming } from './warm';
import { requestPersistentStorage } from './persistence';

export interface OfflineContextValue {
  online: boolean
  engine: SyncEngineState
  counts: OutboxCounts
  syncNow: () => void
  refreshCounts: () => void
}

const EMPTY_COUNTS: OutboxCounts = {
  pending: 0,
  syncing: 0,
  synced: 0,
  conflict: 0,
  failed: 0,
  discarded: 0,
};

const DEFAULT_VALUE: OfflineContextValue = {
  online: true,
  engine: { running: false, lastSyncAt: null, lastError: null, notice: null },
  counts: EMPTY_COUNTS,
  syncNow: () => {},
  refreshCounts: () => {},
};

const OfflineContext = createContext<OfflineContextValue>(DEFAULT_VALUE);

export function OfflineProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(true);
  const [engine, setEngine] = useState<SyncEngineState>(DEFAULT_VALUE.engine);
  const [counts, setCounts] = useState<OutboxCounts>(EMPTY_COUNTS);
  const [, setReplicaVersion] = useState(0);

  const refreshCounts = useCallback(() => {
    void outboxCounts().then(setCounts);
  }, []);

  useEffect(() => {
    void syncEngine.start();
    void startReplicator();
    void startWarming(); // pre-warm RPC-driven views after replica refreshes
    void requestPersistentStorage(); // grant is remembered; free to request every mount
    const unsubNet = networkMonitor.subscribe((s) => setOnline(s.online));
    const unsubEngine = syncEngine.subscribe(setEngine);
    const unsubOutbox = subscribeOutbox(refreshCounts);
    const unsubReplica = subscribeReplica(() => setReplicaVersion((v) => v + 1));
    refreshCounts();
    return () => {
      unsubNet();
      unsubEngine();
      unsubOutbox();
      unsubReplica();
    };
  }, [refreshCounts]);

  const syncNow = useCallback(() => {
    void syncEngine.syncNow();
  }, []);

  return (
    <OfflineContext.Provider value={{ online, engine, counts, syncNow, refreshCounts }}>
      {children}
    </OfflineContext.Provider>
  );
}

export function useOffline(): OfflineContextValue {
  return useContext(OfflineContext);
}
