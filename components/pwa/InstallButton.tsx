'use client';

/**
 * "Install app" pill for the Header's right-actions cluster (sits next to
 * the offline status pill). Only renders where the browser actually offers
 * the install flow (Chromium: beforeinstallprompt) and the user hasn't
 * dismissed it. iOS users get instructions in the Sync Center instead —
 * Safari has no install prompt event.
 */

import { useState } from 'react';
import { Download } from 'lucide-react';
import { useInstallPrompt } from '@/lib/pwa/install';
import { toast } from '@/hooks/use-toast';

export default function InstallButton() {
  const { available, installed, dismissed, platform, install } = useInstallPrompt();
  const [busy, setBusy] = useState(false);

  if (installed || dismissed || platform !== 'chromium' || !available) return null;

  const handle = async () => {
    setBusy(true);
    try {
      const outcome = await install();
      if (outcome === 'accepted') {
        toast({
          title: 'App installed',
          description: 'SI ERP now opens in its own window with a dock/desktop icon.',
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={handle}
      disabled={busy}
      title="Install SI ERP as an app"
      className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-xs font-medium transition-colors bg-violet-50 text-violet-700 border-violet-200 hover:bg-violet-100 disabled:opacity-60"
    >
      <Download className="w-3.5 h-3.5" />
      <span className="hidden sm:inline">Install app</span>
    </button>
  );
}
