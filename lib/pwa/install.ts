'use client';

/**
 * PWA install support.
 *
 * `beforeinstallprompt` can fire before any React component mounts (it
 * follows service-worker activation), so the capturing listener lives at
 * module scope and stashes the event; the hook subscribes to changes.
 *
 * iOS Safari never fires `beforeinstallprompt` — installation is manual
 * (Share → Add to Home Screen), which is why getInstallPlatform() exists:
 * UI can fall back to instructions there.
 */

import { useCallback, useEffect, useState } from 'react';

const DISMISS_KEY = 'si-erp-install-dismissed';

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallPlatform = 'chromium' | 'ios' | 'safari' | 'other';

let promptEvent: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => fn());
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // keep the browser's own mini-infobar out of the way
    promptEvent = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    promptEvent = null;
    notify();
  });
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches ||
    nav.standalone === true
  );
}

export function getInstallPlatform(): InstallPlatform {
  if (typeof window === 'undefined') return 'other';
  const nav = window.navigator;
  const ua = nav.userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  // iPadOS 13+ masquerades as desktop Safari.
  if (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1) return 'ios';
  if (/firefox/i.test(ua)) return 'other'; // no install support
  // macOS Safari supports install (File → Add to Dock) but fires no event.
  if (/safari/i.test(ua) && !/chrome|chromium|edg|opr/i.test(ua)) return 'safari';
  // Chrome, Edge, Opera, Chromium — fires beforeinstallprompt.
  return 'chromium';
}

export interface InstallPromptState {
  available: boolean;
  installed: boolean;
  /** Honours the Header pill's "don't show again" — Sync Center ignores it. */
  dismissed: boolean;
  platform: InstallPlatform;
  install: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
  dismiss: () => void;
}

export function useInstallPrompt(): InstallPromptState {
  // Hidden by default: the truth only exists in the browser, so anything
  // visible during SSR would both flicker and hydrate-mismatch.
  const [state, setState] = useState({
    available: false,
    installed: false,
    dismissed: true,
    platform: 'other' as InstallPlatform,
  });

  useEffect(() => {
    const sync = () =>
      setState({
        available: promptEvent !== null,
        installed: isStandalone(),
        dismissed: window.localStorage.getItem(DISMISS_KEY) === '1',
        platform: getInstallPlatform(),
      });
    sync();
    listeners.add(sync);
    // Installing flips display-mode without firing appinstalled in every browser.
    const mq = window.matchMedia('(display-mode: standalone)');
    mq.addEventListener('change', sync);
    return () => {
      listeners.delete(sync);
      mq.removeEventListener('change', sync);
    };
  }, []);

  const install = useCallback(async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    const ev = promptEvent;
    if (!ev) return 'unavailable';
    await ev.prompt();
    const { outcome } = await ev.userChoice;
    if (outcome === 'accepted') {
      promptEvent = null;
      notify();
    }
    return outcome;
  }, []);

  const dismiss = useCallback(() => {
    window.localStorage.setItem(DISMISS_KEY, '1');
    setState((s) => ({ ...s, dismissed: true }));
  }, []);

  return { ...state, install, dismiss };
}
