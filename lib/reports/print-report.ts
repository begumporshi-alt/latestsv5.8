'use client';

/**
 * Print pipeline for report documents.
 *
 * Why not window.print() on the app page: the app shell contributes the
 * browser's own header/footer (URL, date), the print stylesheet has to hide
 * everything with `body * { visibility: hidden }`, and a fixed-position
 * sidebar can push duplicate pages. Cloning the document into a bare window
 * removes all three problems at once.
 *
 * Why not the existing lib/print.ts helper: it copies the app's stylesheets
 * and forces `@page { margin: 10mm }`. A report sheet needs to own its own
 * page box (full-bleed header band, exact 210×297mm sheets, explicit page
 * numbers), so this writes a self-contained document instead. The report
 * markup uses inline styles only, so nothing depends on Tailwind being loaded
 * in the popup.
 */

const PRINT_CSS = `
  @page { size: A4 portrait; margin: 0; }
  html, body {
    margin: 0;
    padding: 0;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  body { font-family: Arial, Helvetica, sans-serif; }
  .rpt-sheet {
    page-break-after: always;
    break-after: page;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .rpt-sheet:last-child {
    page-break-after: auto;
    break-after: auto;
  }
  table { border-collapse: collapse; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; break-inside: avoid; }
`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

/**
 * Print the given node as a standalone A4 document.
 *
 * Returns false when the popup was blocked, so the caller can fall back to
 * in-page printing instead of silently doing nothing.
 */
export function printReportDocument(node: HTMLElement | null, title: string): boolean {
  if (!node) return false;

  const win = window.open('', '_blank', 'width=920,height=1200');
  if (!win) return false;

  const markup = node.innerHTML;
  win.document.open();
  win.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>${markup}</body>
</html>`);
  win.document.close();

  const fire = () => {
    try {
      win.focus();
      win.print();
    } finally {
      // Give the dialog time to take over before tearing the window down;
      // closing immediately cancels the print in some browsers.
      setTimeout(() => {
        try {
          win.close();
        } catch {
          /* already closed */
        }
      }, 800);
    }
  };

  // Images (the company logo) must be decoded before the clone is rasterised,
  // otherwise the header prints with a blank box. Wait for them, capped so a
  // broken URL cannot block printing forever.
  const images = Array.from(win.document.images || []);
  const pending = images.filter((img) => !img.complete);
  if (pending.length === 0) {
    setTimeout(fire, 150);
    return true;
  }

  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    setTimeout(fire, 120);
  };
  Promise.all(
    pending.map(
      (img) =>
        new Promise<void>((resolve) => {
          img.addEventListener('load', () => resolve(), { once: true });
          img.addEventListener('error', () => resolve(), { once: true });
        }),
    ),
  ).then(done);
  setTimeout(done, 2500);
  return true;
}
