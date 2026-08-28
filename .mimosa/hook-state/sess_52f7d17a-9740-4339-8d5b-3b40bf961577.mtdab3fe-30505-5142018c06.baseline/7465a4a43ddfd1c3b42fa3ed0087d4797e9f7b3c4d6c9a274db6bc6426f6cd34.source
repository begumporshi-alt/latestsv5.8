'use client';

import { useRef, useState, useEffect } from 'react';
import { Camera, X, ScanLine } from 'lucide-react';

interface BarcodeScannerModalProps {
  onDetected: (code: string) => void;
  onClose: () => void;
  title?: string;
}

export default function BarcodeScannerModal({ onDetected, onClose, title = 'Scan Barcode' }: BarcodeScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const supported = typeof window !== 'undefined' && 'BarcodeDetector' in window;

  useEffect(() => {
    if (!supported) return;
    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
          setScanning(true);
          const detector = new (window as any).BarcodeDetector({
            formats: ['code_128', 'code_39', 'ean_13', 'ean_8', 'qr_code'],
          });
          intervalRef.current = setInterval(async () => {
            if (!videoRef.current || videoRef.current.readyState < 2) return;
            try {
              const barcodes = await detector.detect(videoRef.current);
              if (barcodes.length > 0) {
                stopCamera();
                onDetected(barcodes[0].rawValue);
              }
            } catch (_) {}
          }, 300);
        }
      } catch (_) {
        setError('Camera access denied. Allow camera access or enter code manually.');
      }
    }
    startCamera();
    return () => stopCamera();
  }, []);

  function stopCamera() {
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  }

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[120] p-4">
      <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="font-bold text-sm flex items-center gap-2"><ScanLine className="w-4 h-4" />{title}</h3>
          <button onClick={() => { stopCamera(); onClose(); }} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 space-y-4">
          {supported && !error ? (
            <div className="relative">
              <video ref={videoRef} className="w-full rounded-xl bg-black aspect-video object-cover" muted playsInline />
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-48 h-28 border-2 border-blue-400 rounded-xl opacity-80" />
              </div>
              {scanning && <p className="text-xs text-center text-muted-foreground mt-2">Point camera at barcode to scan automatically</p>}
            </div>
          ) : (
            <div className="py-2">
              <p className="text-xs text-center text-muted-foreground">
                {error || 'Camera scanning not supported in this browser.'}
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">{supported && !error ? 'Or type SKU/barcode manually:' : 'Enter SKU/barcode manually:'}</p>
            <div className="flex gap-2">
              <input
                value={manualCode}
                onChange={e => setManualCode(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && manualCode.trim()) { stopCamera(); onDetected(manualCode.trim()); } }}
                placeholder="Product SKU or barcode..."
                autoFocus={!supported || !!error}
                className="flex-1 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
              <button
                onClick={() => { if (manualCode.trim()) { stopCamera(); onDetected(manualCode.trim()); } }}
                disabled={!manualCode.trim()}
                className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-50"
              >
                Search
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
