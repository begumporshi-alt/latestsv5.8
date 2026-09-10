'use client';

/**
 * "Install as app" card for the Sync Center. Unlike the Header pill this
 * section always renders (it ignores the pill's dismissal) so there is a
 * permanent place to install from. Shows:
 *   - Chromium: the install button once the browser offers it, or a hint
 *     while the service worker is still activating.
 *   - iOS:      manual "Add to Home Screen" steps — Safari has no prompt API.
 *   - Safari:   macOS "Add to Dock" steps (supported, but no prompt event).
 *   - installed: a confirmation that this device already runs the app.
 */

import { useState } from 'react';
import { MonitorSmartphone, Share, PlusSquare, CheckCircle2, Download } from 'lucide-react';
import { useInstallPrompt } from '@/lib/pwa/install';
import { toast } from '@/hooks/use-toast';

export default function InstallCard() {
  const { available, installed, platform, install } = useInstallPrompt();
  const [busy, setBusy] = useState(false);

  const handle = async () => {
    setBusy(true);
    try {
      const outcome = await install();
      if (outcome === 'dismissed') {
        toast({ title: 'Install cancelled', description: 'You can install any time from this page.' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-white rounded-xl border border-border p-4 shadow-sm">
      <h2 className="text-sm font-bold text-foreground mb-1 flex items-center gap-2">
        <MonitorSmartphone className="w-4 h-4 text-violet-500" /> Install as app
      </h2>
      <p className="text-xs text-muted-foreground mb-3">
        Installs SI ERP as a standalone app with its own window and icon — launches straight to the
        dashboard, keeps working offline, and never shows browser chrome. Your data, sync queue and
        login are unchanged.
      </p>

      {installed ? (
        <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          <CheckCircle2 className="w-4 h-4" />
          This device is already running the installed app.
        </div>
      ) : platform === 'chromium' ? (
        available ? (
          <button
            onClick={handle}
            disabled={busy}
            className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition disabled:opacity-60"
          >
            <Download className="w-4 h-4" />
            {busy ? 'Installing…' : 'Install app'}
          </button>
        ) : (
          <p className="text-xs text-muted-foreground bg-muted/50 border border-border rounded-lg px-3 py-2">
            Installing becomes available a few seconds after the service worker activates — reload
            the page if the button doesn&apos;t appear.
          </p>
        )
      ) : platform === 'safari' ? (
        <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal list-inside bg-muted/50 border border-border rounded-lg px-3 py-2.5">
          <li>Open the <span className="font-medium">File</span> menu in Safari&apos;s menu bar.</li>
          <li>Choose <span className="font-medium">Add to Dock…</span> and confirm.</li>
          <li>SI ERP will appear in the Dock and launch in its own window.</li>
        </ol>
      ) : platform === 'ios' ? (
        <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal list-inside bg-muted/50 border border-border rounded-lg px-3 py-2.5">
          <li>Tap the <Share className="w-3.5 h-3.5 inline-block mx-0.5 -mt-0.5" /> <span className="font-medium">Share</span> button in Safari&apos;s toolbar.</li>
          <li>Scroll down and choose <span className="font-medium">Add to Home Screen</span>.</li>
          <li>Confirm — SI ERP will appear on your home screen and launch full-screen.</li>
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground bg-muted/50 border border-border rounded-lg px-3 py-2">
          This browser doesn&apos;t support web-app installation. Chrome, Edge and Safari all do.
        </p>
      )}
    </section>
  );
}
