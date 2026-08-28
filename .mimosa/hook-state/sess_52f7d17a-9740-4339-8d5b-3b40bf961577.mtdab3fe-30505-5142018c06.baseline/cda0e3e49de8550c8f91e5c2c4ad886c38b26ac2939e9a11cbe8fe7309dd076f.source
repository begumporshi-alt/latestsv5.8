/**
 * Opens a new browser window containing only the given DOM node's HTML,
 * copies all stylesheets from the parent document, then triggers print.
 * This avoids the browser trying to print the modal overlay / entire page,
 * which causes duplicate pages when position:fixed/absolute elements are present.
 */
export function printNode(node: HTMLElement | null) {
  if (!node) return;

  const win = window.open('', '_blank', 'width=820,height=1000');
  if (!win) {
    alert('Please allow popups to print this document.');
    return;
  }

  // Clone the node so we don't mutate the live DOM
  const clone = node.cloneNode(true) as HTMLElement;
  // Remove any no-print elements from the clone
  clone.querySelectorAll('.no-print').forEach((el) => el.remove());

  // Collect all <style> and <link rel="stylesheet"> from the parent document
  const styleNodes = Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'));
  const headHtml = styleNodes
    .map((s) => s.outerHTML)
    .join('\n');

  win.document.open();
  win.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Print Document</title>
${headHtml}
<style>
  /* Reset for the print window */
  html, body {
    margin: 0 !important;
    padding: 0 !important;
    background: #fff !important;
  }
  body > * {
    visibility: visible !important;
  }
  /* Remove any fixed/absolute positioning that causes duplicate pages */
  .print-modal, .print-document {
    position: static !important;
    top: auto !important;
    left: auto !important;
    inset: auto !important;
    max-width: 100% !important;
    width: 100% !important;
    margin: 0 !important;
    padding: 0 !important;
    border: none !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    overflow: visible !important;
    max-height: none !important;
    background: #fff !important;
    z-index: auto !important;
  }
  @page {
    size: A4 portrait;
    margin: 10mm;
  }
</style>
</head>
<body>
${clone.outerHTML}
</body>
</html>`);
  win.document.close();

  // Wait for styles and images to load before printing
  win.onload = () => {
    setTimeout(() => {
      win.focus();
      win.print();
      // Close the window after a short delay (lets the print dialog finish)
      setTimeout(() => {
        win.close();
      }, 500);
    }, 300);
  };
}
