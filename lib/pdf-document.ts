/**
 * Native vector PDF renderer for invoices and quotations.
 *
 * Unlike the print view (HTML) this draws the document directly with jsPDF so
 * pagination is fully controlled: rows never split mid-row, the table header
 * repeats on every page with a continuation strip, and the totals/signature
 * block always stays together on the final page. Output is selectable text,
 * far smaller than a screenshot-based PDF.
 *
 * jsPDF built-in fonts have no ৳ glyph, so amounts are labelled "BDT".
 */
import { jsPDF } from 'jspdf';
import { formatDate } from '@/lib/format';

const PRIMARY: [number, number, number] = [30, 58, 110]; // #1e3a6e
const GREEN: [number, number, number] = [76, 175, 80];
const RED: [number, number, number] = [185, 28, 28];
const AMBER: [number, number, number] = [180, 83, 9];
const ZEBRA: [number, number, number] = [245, 248, 255];
const HEADER_BG: [number, number, number] = [238, 242, 248];
const BORDER: [number, number, number] = [221, 227, 239];
const TEXT: [number, number, number] = [34, 34, 34];
const MUTED: [number, number, number] = [85, 85, 85];

const STATUS_COLORS: Record<string, [number, number, number]> = {
  paid: GREEN,
  accepted: GREEN,
  partially_paid: [245, 158, 11],
  partial: [245, 158, 11],
  sent: [59, 130, 246],
  viewed: [59, 130, 246],
  overdue: [239, 68, 68],
  rejected: [239, 68, 68],
  draft: [156, 163, 175],
  cancelled: [107, 114, 128],
  converted: [139, 92, 246],
};

export interface PdfDocItem {
  product_name: string;
  product_sku?: string;
  quantity: number;
  unit_price: number;
  discount_percent?: number;
  subtotal: number;
  unit_name?: string;
  warranty_months?: number;
}

export interface PdfDocSpec {
  docType: 'INVOICE' | 'QUOTATION';
  docNumber: string;
  docDate: string;
  dueDate?: string;
  status?: string;
  company: { name: string; address?: string; phone?: string; email?: string; logo_url?: string };
  customer: { name: string; code?: string; phone?: string; address?: string };
  items: PdfDocItem[];
  subtotal: number;
  discountTotal?: number;
  cartDiscount?: number;
  cartDiscountPercent?: number;
  extraDiscount?: number;
  taxAmount?: number;
  taxLabel?: string;
  shippingAmount?: number;
  totalAmount: number;
  amountPaid?: number;
  balanceDue?: number;
  previousDue?: number;
  notes?: string;
  reference?: string;
  salesPerson?: string;
  paymentMethod?: string;
}

const fmt = (n: number) =>
  Number(n).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function loadImage(url: string): Promise<{ dataUrl: string; ratio: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        // Cap resolution: a 2000px logo embedded as-is balloons the PDF to
        // multiple MB; 800px is plenty for a ~60mm print at 2x.
        const scale = Math.min(1, 800 / (img.naturalWidth || 800));
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve({ dataUrl: canvas.toDataURL('image/png'), ratio: img.naturalWidth / img.naturalHeight });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// Rasterize an SVG string to a PNG data URL so icons can be copied 1:1 from
// the print template (PrintTemplate.tsx) instead of being redrawn by hand.
function svgToPngDataUrl(svg: string, px: number): Promise<string | null> {
  return new Promise((resolve) => {
    let url: string | null = null;
    try {
      url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    } catch {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = px;
        canvas.height = px;
        canvas.getContext('2d')!.drawImage(img, 0, 0, px, px);
        resolve(canvas.toDataURL('image/png'));
      } catch {
        resolve(null);
      } finally {
        if (url) URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      if (url) URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

// Same module pattern as QRPlaceholder in PrintTemplate.tsx
const QR_BLOCKS = [
  [1,1,1,0,1,1,1],
  [1,0,1,0,1,0,1],
  [1,0,1,0,1,0,1],
  [1,1,1,0,1,1,1],
  [0,1,0,1,0,1,0],
  [1,0,1,0,1,0,0],
  [1,1,1,0,0,1,1],
];

const iconSvgs = {
  qr: (px: number) => {
    const fills = QR_BLOCKS.map((row, r) =>
      row.map((on, c) => (on ? `<rect x="${c * 10}" y="${r * 10}" width="10" height="10" fill="#1e3a6e"/>` : '')).join(''),
    ).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 70 70">` +
      `<rect width="70" height="70" fill="#fff"/>${fills}` +
      `<rect x="0" y="0" width="30" height="30" fill="none" stroke="#1e3a6e" stroke-width="2"/>` +
      `<rect x="40" y="0" width="30" height="30" fill="none" stroke="#1e3a6e" stroke-width="2"/>` +
      `<rect x="0" y="40" width="30" height="30" fill="none" stroke="#1e3a6e" stroke-width="2"/>` +
      `</svg>`;
  },
  // circle checkmark used inside the status badge
  check: (px: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none">` +
    `<circle cx="12" cy="12" r="10" stroke="#fff" stroke-width="2" fill="rgba(255,255,255,0.25)"/>` +
    `<path d="M8 12l3 3 5-6" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>`,
  // person glyph (BILL TO chip), white on transparent
  person: (px: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none">` +
    `<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke="#fff" stroke-width="2" stroke-linecap="round"/>` +
    `<circle cx="12" cy="7" r="4" stroke="#fff" stroke-width="2"/>` +
    `</svg>`,
  // map pin glyph (company chip), white on transparent
  pin: (px: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none">` +
    `<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" stroke="#fff" stroke-width="2"/>` +
    `<circle cx="12" cy="10" r="3" stroke="#fff" stroke-width="2"/>` +
    `</svg>`,
  // phone handset, navy on transparent
  phone: (px: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none">` +
    `<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.37 11.5 19.79 19.79 0 0 1 1.25 2.85 2 2 0 0 1 3.22 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.09 8.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21 16z" stroke="#1e3a6e" stroke-width="2" stroke-linecap="round"/>` +
    `</svg>`,
  // envelope, navy on transparent
  mail: (px: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none">` +
    `<rect x="2" y="4" width="20" height="16" rx="2" stroke="#1e3a6e" stroke-width="2"/>` +
    `<path d="M2 7l10 7 10-7" stroke="#1e3a6e" stroke-width="2" stroke-linecap="round"/>` +
    `</svg>`,
};

export async function buildDocumentPdf(spec: PdfDocSpec, fileName: string): Promise<File> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const PAGE_W = 210;
  const PAGE_H = 297;
  const M = 12;
  const contentW = PAGE_W - M * 2;
  const bottomLimit = PAGE_H - 18; // room for the page footer

  const isQuote = spec.docType === 'QUOTATION';
  const statusKey = (spec.status || '').toLowerCase().replace(/\s+/g, '_');
  const setFill = (c: [number, number, number]) => doc.setFillColor(c[0], c[1], c[2]);
  const setText = (c: [number, number, number]) => doc.setTextColor(c[0], c[1], c[2]);
  const setDraw = (c: [number, number, number]) => doc.setDrawColor(c[0], c[1], c[2]);

  let y = M;

  function drawContinuationHeader() {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    setText(PRIMARY);
    doc.text(spec.company.name.toUpperCase(), M, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    setText(MUTED);
    doc.text(`${spec.docType} ${spec.docNumber}`, PAGE_W - M, y, { align: 'right' });
    y += 4;
    setDraw(PRIMARY);
    doc.setLineWidth(0.4);
    doc.line(M, y, PAGE_W - M, y);
    y += 6;
  }

  // ── Page 1 letterhead ────────────────────────────────────────────────
  const [logo, qrImg, checkIcon, personIcon, pinIcon, phoneIcon, mailIcon] = await Promise.all([
    spec.company.logo_url ? loadImage(spec.company.logo_url) : Promise.resolve(null),
    svgToPngDataUrl(iconSvgs.qr(560), 560),
    svgToPngDataUrl(iconSvgs.check(96), 96),
    svgToPngDataUrl(iconSvgs.person(96), 96),
    svgToPngDataUrl(iconSvgs.pin(96), 96),
    svgToPngDataUrl(iconSvgs.phone(96), 96),
    svgToPngDataUrl(iconSvgs.mail(96), 96),
  ]);
  const logoH = 22;
  const logoW = logo ? Math.min(logo.ratio * logoH, 70) : 0;

  if (logo) {
    try {
      doc.addImage(logo.dataUrl, 'PNG', M, y, logoW, logoH);
    } catch {
      /* skip a logo that jsPDF cannot decode */
    }
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(26);
  setText(PRIMARY);
  doc.text(spec.docType, PAGE_W - M, y + 12, { align: 'right' });

  if (statusKey) {
    const label = statusKey.replace(/_/g, ' ').toUpperCase();
    doc.setFontSize(9);
    const tw = doc.getTextWidth(label);
    const chipW = tw + 13;
    const chipH = 7;
    const chipX = PAGE_W - M - chipW;
    setFill(STATUS_COLORS[statusKey] || PRIMARY);
    doc.roundedRect(chipX, y + 15.5, chipW, chipH, 1.5, 1.5, 'F');
    if (checkIcon) {
      try {
        doc.addImage(checkIcon, 'PNG', chipX + 2.4, y + 15.5 + (chipH - 3.6) / 2, 3.6, 3.6);
      } catch {
        /* ignore icon rasterization failures */
      }
    }
    doc.setTextColor(255, 255, 255);
    doc.text(label, chipX + 7.4, y + 15.5 + chipH / 2 + 1.2);
  }

  y += logoH + 3;
  setDraw(PRIMARY);
  doc.setLineWidth(0.8);
  doc.line(M, y, PAGE_W - M, y);
  y += 1.4;
  setDraw(BORDER);
  doc.setLineWidth(0.2);
  doc.line(M, y, PAGE_W - M, y);
  y += 5;

  // ── Info band: BILL TO | company | document details ──────────────────
  const infoTop = y;
  const colW = contentW / 3;

  const infoLabel = (text: string, x: number, yy: number) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    setText(PRIMARY);
    doc.text(text, x, yy);
  };

  // navy circle chips with white glyphs, matching the preview's icon badges
  const drawChip = (cx: number, cy: number, icon: string | null) => {
    setFill(PRIMARY);
    doc.circle(cx, cy, 2.3, 'F');
    if (icon) {
      try {
        doc.addImage(icon, 'PNG', cx - 1.1, cy - 1.1, 2.2, 2.2);
      } catch {
        /* ignore icon rasterization failures */
      }
    }
  };

  // Column 1: BILL TO
  drawChip(M + 2.3, y - 1.6, personIcon);
  infoLabel('BILL TO', M + 6.2, y);
  y += 5;
  doc.setFontSize(9);
  const billRows: [string, string][] = [
    ['Customer Name', spec.customer.name],
    ...(spec.customer.code ? [['Customer ID', spec.customer.code] as [string, string]] : []),
    ...(spec.customer.phone ? [['Phone', spec.customer.phone] as [string, string]] : []),
    ...(spec.customer.address ? [['Address', spec.customer.address] as [string, string]] : []),
  ];
  for (const [label, value] of billRows) {
    const wrapped = doc.splitTextToSize(value, colW - 26);
    doc.setFont('helvetica', 'normal');
    setText(MUTED);
    doc.text(label, M, y);
    doc.text(':', M + 22, y);
    doc.setFont('helvetica', 'bold');
    setText(TEXT);
    doc.text(wrapped, M + 25, y);
    y += wrapped.length * 4 + 0.6;
  }

  // Column 2: company info
  let cy = infoTop;
  const col2x = M + colW;
  drawChip(col2x + 2.3, cy - 1.6, pinIcon);
  infoLabel(spec.company.name.toUpperCase(), col2x + 6.2, cy);
  cy += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  setText(MUTED);
  if (spec.company.address) {
    const wrapped = doc.splitTextToSize(spec.company.address, colW - 8);
    doc.text(wrapped, col2x, cy);
    cy += wrapped.length * 4 + 1.5;
  }
  if (spec.company.phone) {
    setText(TEXT);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    if (phoneIcon) {
      try {
        doc.addImage(phoneIcon, 'PNG', col2x, cy - 2.3, 2.6, 2.6);
      } catch {
        /* ignore icon rasterization failures */
      }
    }
    doc.text(doc.splitTextToSize(spec.company.phone, colW - 12), col2x + 3.8, cy);
    cy += 4;
  }
  if (spec.company.email) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    if (mailIcon) {
      try {
        doc.addImage(mailIcon, 'PNG', col2x, cy - 2.3, 2.6, 2.6);
      } catch {
        /* ignore icon rasterization failures */
      }
    }
    doc.text(doc.splitTextToSize(spec.company.email, colW - 12), col2x + 3.8, cy);
    cy += 4;
  }

  // Column 3: document details
  let dy = infoTop;
  const col3x = M + colW * 2;
  const detailRows: [string, string][] = [
    [isQuote ? 'Quotation No.' : 'Invoice No.', spec.docNumber],
    [isQuote ? 'Issue Date' : 'Invoice Date', formatDate(spec.docDate)],
    ...(spec.dueDate ? [[isQuote ? 'Valid Until' : 'Due Date', formatDate(spec.dueDate)] as [string, string]] : []),
    ['Sales Person', spec.salesPerson || 'Admin'],
    ...(spec.paymentMethod ? [['Payment Method', spec.paymentMethod.replace(/\b\w/g, (c) => c.toUpperCase())] as [string, string]] : []),
    ...(spec.reference ? [['Reference', spec.reference] as [string, string]] : []),
  ];
  for (const [label, value] of detailRows) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    setText(MUTED);
    doc.text(label, col3x, dy);
    doc.text(':', col3x + colW - 40, dy);
    const boldNo = label.endsWith('No.');
    doc.setFont('helvetica', boldNo ? 'bold' : 'normal');
    setText(boldNo ? PRIMARY : TEXT);
    doc.text(value, col3x + colW - 4, dy, { align: 'right' });
    dy += 4.6;
  }

  y = Math.max(y, cy, dy) + 3;
  setDraw(PRIMARY);
  doc.setLineWidth(0.5);
  doc.line(M, y, PAGE_W - M, y);
  // column separators
  doc.setLineWidth(0.15);
  setDraw(BORDER);
  doc.line(M + colW, infoTop - 1, M + colW, y);
  doc.line(M + colW * 2, infoTop - 1, M + colW * 2, y);
  y += 5;

  // ── Items table ──────────────────────────────────────────────────────
  const col = {
    sl: 9,
    code: 26,
    unit: 16,
    warranty: 14,
    qty: 12,
    rate: 22,
    amount: 26,
  };
  col.unit = 16;
  const detailsW = contentW - col.sl - col.code - col.unit - col.warranty - col.qty - col.rate - col.amount;

  const colX = {
    sl: M,
    code: M + col.sl,
    details: M + col.sl + col.code,
    warranty: M + col.sl + col.code + detailsW,
    unit: M + col.sl + col.code + detailsW + col.warranty,
    qty: M + col.sl + col.code + detailsW + col.warranty + col.unit,
    rate: M + col.sl + col.code + detailsW + col.warranty + col.unit + col.qty,
    amount: M + col.sl + col.code + detailsW + col.warranty + col.unit + col.qty + col.rate,
  };

  function drawTableHeader() {
    setFill(HEADER_BG);
    doc.rect(M, y - 4.2, contentW, 8, 'F');
    setDraw(PRIMARY);
    doc.setLineWidth(0.4);
    doc.line(M, y + 3.8, PAGE_W - M, y + 3.8);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    setText(PRIMARY);
    const mid = (x: number, w: number, t: string) => doc.text(t, x + w / 2, y, { align: 'center' });
    mid(colX.sl, col.sl, 'SL');
    doc.text('ITEM CODE', colX.code + 1, y);
    doc.text('ITEM DETAILS', colX.details + 1, y);
    mid(colX.warranty, col.warranty, 'WARR.');
    mid(colX.unit, col.unit, 'UNIT');
    mid(colX.qty, col.qty, 'QTY');
    doc.text('NET RATE', colX.rate + col.rate, y, { align: 'right' });
    doc.text('AMOUNT', colX.amount + col.amount, y, { align: 'right' });
    y += 7.2;
  }

  drawTableHeader();

  spec.items.forEach((item, idx) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    const nameLines = doc.splitTextToSize(item.product_name || 'Item', detailsW - 3) as string[];
    const codeLines = doc.splitTextToSize(item.product_sku || '—', col.code - 2) as string[];
    const rowH = Math.max(nameLines.length * 3.9, codeLines.length * 3.9, 7) + 1.2;

    if (y + rowH > bottomLimit) {
      doc.addPage();
      y = M + 8;
      drawContinuationHeader();
      drawTableHeader();
    }

    if (idx % 2 === 1) {
      setFill(ZEBRA);
      doc.rect(M, y - 3.2, contentW, rowH, 'F');
    }
    setDraw(BORDER);
    doc.setLineWidth(0.1);
    doc.line(M, y - 3.2 + rowH, PAGE_W - M, y - 3.2 + rowH);

    const baseY = y;
    setText(MUTED);
    doc.text(String(idx + 1), colX.sl + col.sl / 2, baseY, { align: 'center' });
    doc.text(codeLines, colX.code + 1, baseY);
    setText(TEXT);
    doc.text(nameLines, colX.details + 1, baseY);
    setText(MUTED);
    doc.text(item.warranty_months && item.warranty_months > 0 ? `${item.warranty_months}mo` : '—', colX.warranty + col.warranty / 2, baseY, { align: 'center' });
    doc.text(item.unit_name || '—', colX.unit + col.unit / 2, baseY, { align: 'center' });
    setText(TEXT);
    doc.text(String(item.quantity), colX.qty + col.qty / 2, baseY, { align: 'center' });
    const netRate = Number(item.unit_price) * (1 - (item.discount_percent || 0) / 100);
    doc.text(netRate.toFixed(2), colX.rate + col.rate, baseY, { align: 'right' });
    doc.setFont('helvetica', 'bold');
    doc.text(Number(item.subtotal).toFixed(2), colX.amount + col.amount, baseY, { align: 'right' });
    doc.setFont('helvetica', 'normal');

    y = baseY - 3.2 + rowH + 3.2;
  });

  y += 2;
  setDraw(PRIMARY);
  doc.setLineWidth(0.5);
  doc.line(M, y, PAGE_W - M, y);
  y += 2;

  // ── Totals + QR band (kept together) ─────────────────────────────────
  const isInvoice = spec.docType === 'INVOICE';
  const discountTotal = spec.discountTotal || 0;
  const showInvoiceDueBreakdown = isInvoice && spec.previousDue !== undefined;
  const previousDueAmount = Math.max(0, Number(spec.previousDue || 0));
  const totalDueAmount = Number(spec.totalAmount) + previousDueAmount;
  const currentDueAmount = previousDueAmount + Number(spec.balanceDue || 0);
  const displayedSubtotal = Number(spec.subtotal) + discountTotal;

  const totalsRows: { label: string; value: string; color?: [number, number, number]; bold?: boolean; size?: number; border?: 'strong' | 'light' }[] = [
    { label: 'Subtotal', value: fmt(displayedSubtotal) },
    ...(discountTotal > 0 ? [{ label: 'Item Discount', value: `-${fmt(discountTotal)}` }] : []),
    ...(spec.cartDiscount && spec.cartDiscount > 0
      ? [{ label: `Cart Discount${spec.cartDiscountPercent ? ` (${spec.cartDiscountPercent}%)` : ''}`, value: `-${fmt(spec.cartDiscount)}` }]
      : []),
    ...(spec.extraDiscount && spec.extraDiscount > 0 ? [{ label: 'Extra Discount', value: `-${fmt(spec.extraDiscount)}` }] : []),
    ...(spec.taxAmount && spec.taxAmount > 0 ? [{ label: spec.taxLabel || 'VAT', value: `+${fmt(spec.taxAmount)}` }] : []),
    ...(spec.shippingAmount && spec.shippingAmount > 0 ? [{ label: 'Shipping /Service Fee', value: `+${fmt(spec.shippingAmount)}` }] : []),
    { label: 'GRAND TOTAL', value: fmt(spec.totalAmount), color: PRIMARY, bold: true, size: 11.5, border: 'strong' },
  ];

  if (showInvoiceDueBreakdown) {
    totalsRows.push({ label: 'Previous Due', value: `+${fmt(previousDueAmount)}`, color: AMBER });
    totalsRows.push({ label: 'TOTAL DUE', value: fmt(totalDueAmount), color: RED, bold: true, border: 'light' });
    totalsRows.push({ label: 'Paid', value: `-${fmt(spec.amountPaid || 0)}`, color: GREEN });
    totalsRows.push({ label: 'CURRENT DUE', value: fmt(currentDueAmount), color: PRIMARY, bold: true, size: 11.5, border: 'light' });
  } else if (isInvoice) {
    if ((spec.amountPaid || 0) > 0) totalsRows.push({ label: 'Amount Paid', value: `-${fmt(spec.amountPaid || 0)}`, color: GREEN });
    totalsRows.push({ label: 'BALANCE DUE', value: fmt(spec.balanceDue || 0), color: PRIMARY, bold: true, size: 11.5, border: 'light' });
  }

  const rowH = (r: { size?: number }) => (r.size ? r.size * 0.7 + 4.5 : 6.2);
  const totalsBlockH = totalsRows.reduce((h, r) => h + rowH(r), 8) + 1.5;

  if (y + totalsBlockH > bottomLimit) {
    doc.addPage();
    y = M + 8;
    drawContinuationHeader();
  }

  const totalsW = contentW * 0.55;
  const totalsX = PAGE_W - M - totalsW;
  const totalsTop = y + 2;

  // Left: QR block
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  setText(PRIMARY);
  doc.text('SCAN TO VERIFY', M, totalsTop + 2);
  setDraw(PRIMARY);
  doc.setLineWidth(0.5);
  const qrSize = 22;
  // boxed like the print template: navy frame with a white inset around the pattern
  doc.rect(M, totalsTop + 5, qrSize + 2.4, qrSize + 2.4);
  // QR rasterized from the exact QRPlaceholder SVG in PrintTemplate.tsx so it
  // is identical to the preview/print
  if (qrImg) {
    try {
      doc.addImage(qrImg, 'PNG', M + 1.2, totalsTop + 6.2, qrSize, qrSize);
    } catch {
      /* ignore rasterization failures */
    }
  }

  // Right: totals rows
  let ty = totalsTop + 4;
  for (const row of totalsRows) {
    if (row.border === 'strong') {
      setDraw(PRIMARY);
      doc.setLineWidth(0.7);
      doc.line(totalsX, ty - 3.4, PAGE_W - M, ty - 3.4);
      ty += 1.5; // breathing room under the GRAND TOTAL rule
    } else if (row.border === 'light') {
      setDraw(BORDER);
      doc.setLineWidth(0.25);
      doc.line(totalsX, ty - 3.4, PAGE_W - M, ty - 3.4);
    }
    doc.setFont('helvetica', row.bold ? 'bold' : 'normal');
    doc.setFontSize(row.size || 9);
    setText(row.color || MUTED);
    doc.text(row.label, totalsX + 2, ty);
    doc.text(row.value, PAGE_W - M - 2, ty, { align: 'right' });
    ty += rowH(row);
  }

  y = Math.max(totalsTop + 5 + qrSize + 2.4, ty) + 4;
  // vertical divider between the QR panel and the totals, running to the footer rule
  setDraw(BORDER);
  doc.setLineWidth(0.2);
  doc.line(totalsX, totalsTop, totalsX, y);

  // ── Footer band: Terms | Thank You | Signatures — 3 columns like the print preview ──
  const footerBlockH = 42;
  if (y + footerBlockH > bottomLimit) {
    doc.addPage();
    y = M + 8;
    drawContinuationHeader();
  }
  setDraw(PRIMARY);
  doc.setLineWidth(0.7);
  doc.line(M, y, PAGE_W - M, y);
  const bandTop = y + 3;

  const termsW = contentW * 0.34;
  const thanksW = contentW * 0.29;
  const sigW = contentW - termsW - thanksW;
  const thanksX = M + termsW;
  const sigX = thanksX + thanksW;

  // Terms (left column, text wrapped inside its column so it can never
  // run under the Thank You block)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  setText(PRIMARY);
  doc.text('TERMS & CONDITIONS', M, bandTop + 3);
  setFill(PRIMARY);
  doc.rect(M, bandTop + 4.3, 32, 0.7, 'F');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  setText(TEXT);
  let termsY = bandTop + 10;
  const termItems = [
    '1. Please check all items and quantities before leaving the store.',
    '2. Any discrepancy must be reported within 24 hours.',
  ];
  for (const term of termItems) {
    const lines = doc.splitTextToSize(term, termsW - 4) as string[];
    doc.text(lines, M, termsY);
    termsY += lines.length * 3.9;
  }
  let termsBottom = termsY - 3.9 + 2;
  if (spec.notes) {
    setText(MUTED);
    const noteLines = doc.splitTextToSize(`Notes: ${spec.notes}`, termsW - 4) as string[];
    doc.text(noteLines, M, termsY + 1);
    termsBottom = termsY + 1 + (noteLines.length - 1) * 3.9 + 2;
  }

  const bandBottom = bandTop + Math.max(termsBottom - bandTop, 26);

  // Column dividers
  setDraw(BORDER);
  doc.setLineWidth(0.2);
  doc.line(thanksX, bandTop, thanksX, bandBottom);
  doc.line(sigX, bandTop, sigX, bandBottom);
  doc.line(sigX + sigW / 2, bandTop, sigX + sigW / 2, bandBottom);

  // Signatures line baseline for the band
  const sigLineY = bandBottom - 5;

  // Thank You (center column): FOR YOUR BUSINESS baseline matches the
  // "Customer Signature" label baseline (sigLineY + 3.5) so the two sit level
  const thanksCX = thanksX + thanksW / 2;
  const thanksCY = sigLineY - 3;
  doc.setFont('helvetica', 'bolditalic');
  doc.setFontSize(16);
  setText(PRIMARY);
  doc.text('Thank You!', thanksCX, thanksCY, { align: 'center' });
  setFill(GREEN);
  doc.rect(thanksCX - 12, thanksCY + 2.2, 24, 0.7, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.5);
  setText(GREEN);
  doc.text('FOR YOUR BUSINESS', thanksCX, thanksCY + 6.5, { align: 'center' });

  // Signatures (right column): person + pen icons above the lines
  const custCX = sigX + sigW * 0.25;
  const authCX = sigX + sigW * 0.75;
  const lineHalf = 11;
  doc.setDrawColor(153, 153, 153);
  doc.setLineWidth(0.35);
  doc.line(custCX - lineHalf, sigLineY, custCX + lineHalf, sigLineY);
  doc.line(authCX - lineHalf, sigLineY, authCX + lineHalf, sigLineY);
  // person icon (head + shoulders)
  doc.setDrawColor(120, 120, 120);
  doc.setLineWidth(0.45);
  doc.circle(custCX, sigLineY - 6.4, 1.4, 'S');
  doc.lines([[0, -2.2, 4.6, -2.2, 4.6, 0]], custCX - 2.3, sigLineY - 3.2, [1, 1], 'S');
  // pen icon (shaft + nib)
  doc.setLineWidth(0.55);
  doc.line(authCX - 1.8, sigLineY - 2.8, authCX + 1.6, sigLineY - 7.2);
  setFill([120, 120, 120]);
  doc.triangle(authCX - 1.9, sigLineY - 2.7, authCX - 0.5, sigLineY - 2.7, authCX - 1.9, sigLineY - 4.1, 'F');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  setText(MUTED);
  doc.text('Customer Signature', custCX, sigLineY + 3.5, { align: 'center' });
  doc.text('Authorized Signature', authCX, sigLineY + 3.5, { align: 'center' });

  // ── Footers on every page: contact + page number ─────────────────────
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    setText(MUTED);
    const contact = [spec.company.phone, spec.company.email].filter(Boolean).join('  |  ');
    doc.text(contact, PAGE_W / 2, PAGE_H - 8, { align: 'center' });
    doc.setFontSize(7.5);
    doc.text(`${spec.docNumber}  ·  Page ${p} of ${totalPages}  ·  All amounts in BDT`, PAGE_W / 2, PAGE_H - 4.5, { align: 'center' });
  }

  return new File([doc.output('blob')], fileName, { type: 'application/pdf' });
}
