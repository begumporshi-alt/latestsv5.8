'use client';

import { formatDate } from '@/lib/format';

export interface GrnPrintItem {
  product_name: string;
  product_sku?: string;
  unit_name?: string;
  quantity: number;
  unit_cost: number;
}

export interface GrnPrintProps {
  grnNumber: string;
  grnDate: string;
  status?: string;
  poNumber?: string;
  warehouse?: string;
  reference?: string;
  company: {
    name: string;
    address?: string;
    phone?: string;
    email?: string;
    logo_url?: string;
  };
  supplier: {
    name: string;
    code?: string;
    phone?: string;
  };
  items: GrnPrintItem[];
  totalValue: number;
  notes?: string;
  costUpdates?: { name: string; before: number; after: number; forced?: boolean }[];
  saleUpdates?: { name: string; before: number; after: number }[];
}

const PRIMARY = '#1e3a6e';
const GREEN = '#4caf50';

const statusConfig: Record<string, { bg: string; color: string }> = {
  draft:     { bg: '#9ca3af', color: '#fff' },
  posted:    { bg: GREEN,     color: '#fff' },
  cancelled: { bg: '#6b7280', color: '#fff' },
};

const fmt = (n: number) =>
  '৳' +
  Number(n).toLocaleString('en-BD', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export default function GrnPrint({
  grnNumber,
  grnDate,
  status,
  poNumber,
  warehouse,
  reference,
  company,
  supplier,
  items,
  totalValue,
  notes,
  costUpdates,
  saleUpdates,
}: GrnPrintProps) {
  const normalizedStatus = (status || '').toLowerCase().replace(/\s+/g, '_');
  const badge = statusConfig[normalizedStatus] || statusConfig.draft;

  const logoSrc = company.logo_url || '/Whats-App-Image-2026-07-09-at-15-57-58.jpg';

  return (
    <>
      {/* Print-specific global styles */}
      <style>{`
        @media print {
          @page {
            size: A4;
            margin: 8mm;
          }
          .print-document {
            position: static !important;
            width: 100% !important;
            max-width: 100% !important;
            margin: 0 auto;
            border: none !important;
            border-radius: 0 !important;
            box-shadow: none !important;
            overflow: visible !important;
          }
          .print-header-logo { height: 52px !important; }
          .print-items-table tr { page-break-inside: avoid; break-inside: avoid; }
          .print-totals-section, .print-footer-section { page-break-inside: avoid; break-inside: avoid; }
          .print-items-table td, .print-items-table th { padding-top: 2px !important; padding-bottom: 2px !important; }
        }
      `}</style>

      <div
        className="print-document"
        style={{
          fontFamily: 'Arial, Helvetica, sans-serif',
          color: '#222',
          background: '#fff',
          maxWidth: '800px',
          margin: '0 auto',
          border: '1px solid #dde3ef',
          borderRadius: '4px',
          overflow: 'visible',
          boxSizing: 'border-box',
        }}
      >
        {/* ═══════════════════ HEADER ═══════════════════ */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 20px',
            borderBottom: `3px solid ${PRIMARY}`,
            background: '#fff',
            gap: '14px',
          }}
        >
          {/* Left: Logo image */}
          <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            <img
              src={logoSrc}
              alt="SI Building Solutions"
              className="print-header-logo"
              style={{
                height: '72px',
                width: 'auto',
                maxWidth: '380px',
                objectFit: 'contain',
                display: 'block',
              }}
            />
          </div>

          {/* Vertical divider */}
          <div
            style={{
              width: '1.5px',
              alignSelf: 'stretch',
              background: '#ccc',
              flexShrink: 0,
              margin: '4px 0',
            }}
          />

          {/* Right: Doc type title + status badge */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '16px',
              flexShrink: 0,
            }}
          >
            <div
              style={{
                fontSize: '22px',
                fontWeight: '900',
                color: PRIMARY,
                letterSpacing: '1.5px',
                lineHeight: '1.1',
              }}
            >
              GOODS RECEIVED NOTE
            </div>

            {status && (
              <div
                style={{
                  background: badge.bg,
                  color: badge.color,
                  padding: '6px 14px',
                  borderRadius: '6px',
                  fontWeight: '700',
                  fontSize: '13px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '7px',
                  letterSpacing: '0.5px',
                  whiteSpace: 'nowrap',
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="#fff" strokeWidth="2" fill="rgba(255,255,255,0.25)" />
                  <path
                    d="M8 12l3 3 5-6"
                    stroke="#fff"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {status.toUpperCase().replace(/_/g, ' ')}
              </div>
            )}
          </div>
        </div>

        {/* ═══════════════════ INFO SECTION ═══════════════════ */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            borderBottom: `2px solid ${PRIMARY}`,
          }}
        >
          {/* Supplier */}
          <div style={{ padding: '8px 16px', borderRight: '1px solid #dde3ef' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
              <div
                style={{
                  width: '22px',
                  height: '22px',
                  background: PRIMARY,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
                  <circle cx="12" cy="7" r="4" stroke="#fff" strokeWidth="2" />
                </svg>
              </div>
              <span style={{ fontWeight: '800', fontSize: '11px', color: PRIMARY, letterSpacing: '1.5px' }}>
                SUPPLIER
              </span>
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
              <tbody>
                <tr>
                  <td style={{ color: '#666', paddingBottom: '2px', whiteSpace: 'nowrap', paddingRight: '6px' }}>Supplier Name</td>
                  <td style={{ color: '#666', paddingBottom: '2px', paddingRight: '4px' }}>:</td>
                  <td style={{ fontWeight: '700', paddingBottom: '2px' }}>{supplier.name}</td>
                </tr>
                {supplier.code && (
                  <tr>
                    <td style={{ color: '#666', paddingBottom: '2px', paddingRight: '6px' }}>Supplier ID</td>
                    <td style={{ color: '#666', paddingBottom: '2px', paddingRight: '4px' }}>:</td>
                    <td style={{ fontWeight: '700', paddingBottom: '2px' }}>{supplier.code}</td>
                  </tr>
                )}
                {supplier.phone && (
                  <tr>
                    <td style={{ color: '#666', paddingBottom: '2px', paddingRight: '6px' }}>Phone</td>
                    <td style={{ color: '#666', paddingBottom: '2px', paddingRight: '4px' }}>:</td>
                    <td style={{ fontWeight: '700', paddingBottom: '2px' }}>{supplier.phone}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Company Info */}
          <div style={{ padding: '8px 16px', borderRight: '1px solid #dde3ef' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
              <div
                style={{
                  width: '22px',
                  height: '22px',
                  background: PRIMARY,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" stroke="#fff" strokeWidth="2" />
                  <circle cx="12" cy="10" r="3" stroke="#fff" strokeWidth="2" />
                </svg>
              </div>
              <span style={{ fontWeight: '800', fontSize: '11px', color: PRIMARY, letterSpacing: '1px' }}>
                {company.name.toUpperCase()}
              </span>
            </div>

            {company.address && (
              <div style={{ fontSize: '11px', color: '#444', lineHeight: '1.5', marginBottom: '6px' }}>
                {company.address}
              </div>
            )}

            {company.phone && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', marginBottom: '3px', color: '#333' }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.37 11.5 19.79 19.79 0 0 1 1.25 2.85 2 2 0 0 1 3.22 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.09 8.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21 16z" stroke={PRIMARY} strokeWidth="2" strokeLinecap="round" />
                </svg>
                <span style={{ fontWeight: '600' }}>{company.phone}</span>
              </div>
            )}

            {company.email && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#333' }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                  <rect x="2" y="4" width="20" height="16" rx="2" stroke={PRIMARY} strokeWidth="2" />
                  <path d="M2 7l10 7 10-7" stroke={PRIMARY} strokeWidth="2" strokeLinecap="round" />
                </svg>
                <span style={{ fontWeight: '600' }}>{company.email}</span>
              </div>
            )}
          </div>

          {/* GRN Details */}
          <div style={{ padding: '8px 16px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
              <tbody>
                <tr>
                  <td style={{ color: '#555', paddingBottom: '3px', whiteSpace: 'nowrap' }}>GRN No.</td>
                  <td style={{ color: '#555', paddingBottom: '3px', textAlign: 'center', width: '16px' }}>:</td>
                  <td style={{ fontWeight: '800', color: PRIMARY, paddingBottom: '3px', textAlign: 'right' }}>
                    {grnNumber}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: '#555', paddingBottom: '3px' }}>Received Date</td>
                  <td style={{ color: '#555', paddingBottom: '3px', textAlign: 'center' }}>:</td>
                  <td style={{ fontWeight: '600', paddingBottom: '3px', textAlign: 'right' }}>
                    {formatDate(grnDate)}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: '#555', paddingBottom: '3px' }}>PO Reference</td>
                  <td style={{ color: '#555', paddingBottom: '3px', textAlign: 'center' }}>:</td>
                  <td style={{ fontWeight: '600', paddingBottom: '3px', textAlign: 'right' }}>
                    {poNumber || 'Direct Receipt'}
                  </td>
                </tr>
                {warehouse && (
                  <tr>
                    <td style={{ color: '#555', paddingBottom: '3px' }}>Warehouse</td>
                    <td style={{ color: '#555', paddingBottom: '3px', textAlign: 'center' }}>:</td>
                    <td style={{ fontWeight: '600', paddingBottom: '3px', textAlign: 'right' }}>
                      {warehouse}
                    </td>
                  </tr>
                )}
                {reference && (
                  <tr>
                    <td style={{ color: '#555', paddingBottom: '3px' }}>Reference</td>
                    <td style={{ color: '#555', paddingBottom: '3px', textAlign: 'center' }}>:</td>
                    <td style={{ fontWeight: '600', paddingBottom: '3px', textAlign: 'right' }}>
                      {reference}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ═══════════════════ ITEMS TABLE ═══════════════════ */}
        <table className="print-items-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#eef2f8' }}>
              {[
                { label: 'SL',          align: 'center' as const, width: '36px' },
                { label: 'ITEM CODE',   align: 'left'   as const, width: '90px' },
                { label: 'ITEM DETAILS', align: 'left'  as const },
                { label: 'UNIT',        align: 'center' as const, width: '64px' },
                { label: 'QTY',         align: 'center' as const, width: '48px' },
                { label: 'RATE (৳)',    align: 'right'  as const, width: '90px' },
                { label: 'AMOUNT (৳)',  align: 'right'  as const, width: '96px' },
              ].map((col) => (
                <th
                  key={col.label}
                  style={{
                    padding: '5px 8px',
                    textAlign: col.align,
                    fontSize: '10px',
                    fontWeight: '700',
                    letterSpacing: '0.4px',
                    width: col.width,
                    color: PRIMARY,
                    borderRight: '1px solid #dde3ef',
                    borderBottom: `2px solid ${PRIMARY}`,
                  }}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ padding: '20px', textAlign: 'center', color: '#aaa', fontSize: '13px' }}>
                  No items
                </td>
              </tr>
            ) : (
              items.map((item, idx) => (
                <tr
                  key={idx}
                  style={{
                    background: idx % 2 === 0 ? '#fff' : '#f5f8ff',
                    borderBottom: '1px solid #e8edf6',
                  }}
                >
                  <td style={{ padding: '3px 8px', textAlign: 'center', fontSize: '11px', color: '#555' }}>{idx + 1}</td>
                  <td style={{ padding: '3px 8px', textAlign: 'left',   fontSize: '11px', color: '#555' }}>{item.product_sku || '—'}</td>
                  <td style={{ padding: '3px 8px', textAlign: 'left', fontSize: '11px', fontWeight: '500' }}>
                    {item.product_name}
                  </td>
                  <td style={{ padding: '3px 8px', textAlign: 'center', fontSize: '11px', color: '#3b82f6', fontWeight: '600' }}>
                    {item.unit_name || '—'}
                  </td>
                  <td style={{ padding: '3px 8px', textAlign: 'center', fontSize: '11px' }}>{item.quantity}</td>
                  <td style={{ padding: '3px 8px', textAlign: 'right', fontSize: '11px' }}>{Number(item.unit_cost).toFixed(2)}</td>
                  <td style={{ padding: '3px 8px', textAlign: 'right', fontSize: '11px', fontWeight: '600' }}>
                    {(Number(item.quantity) * Number(item.unit_cost)).toFixed(2)}
                  </td>
                </tr>
              ))
            )}

            {/* Filler rows to fill the A4 page professionally */}
            {Array.from({ length: Math.max(0, 10 - items.length) }).map((_, idx) => (
              <tr
                key={`filler-${idx}`}
                style={{
                  background: (items.length + idx) % 2 === 0 ? '#fff' : '#f5f8ff',
                  borderBottom: '1px solid #e8edf6',
                }}
              >
                {Array.from({ length: 7 }).map((_, colIdx) => (
                  <td key={colIdx} style={{ padding: '3px 8px', fontSize: '11px', height: '20px' }}>&nbsp;</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {/* ═══════════════════ NOTES + TOTALS ═══════════════════ */}
        <div className="print-totals-section" style={{ display: 'flex', borderTop: `2px solid ${PRIMARY}` }}>
          {/* Notes */}
          <div
            style={{
              flex: '0 0 40%',
              padding: '8px 16px',
              borderRight: '1px solid #dde3ef',
            }}
          >
            <div style={{ fontWeight: '800', fontSize: '10px', color: PRIMARY, marginBottom: '6px', letterSpacing: '1.5px' }}>
              NOTES
            </div>
            <div style={{ fontSize: '10px', color: '#555', lineHeight: '1.6' }}>
              {notes || 'All items received in good condition and counted at the warehouse above.'}
            </div>
            {costUpdates && costUpdates.length > 0 && (
              <div style={{ marginTop: '6px' }}>
                <div style={{ fontSize: '9px', fontWeight: '700', color: '#b45309', letterSpacing: '1px', marginBottom: '2px' }}>
                  COST PRICE UPDATED
                </div>
                {costUpdates.map((u, i) => (
                  <div key={i} style={{ fontSize: '10px', color: '#92400e' }}>
                    {u.name}: ৳{Number(u.before).toFixed(2)} → ৳{Number(u.after).toFixed(2)}{u.forced ? ' (forced)' : ''}
                  </div>
                ))}
              </div>
            )}
            {saleUpdates && saleUpdates.length > 0 && (
              <div style={{ marginTop: '6px' }}>
                <div style={{ fontSize: '9px', fontWeight: '700', color: '#1d4ed8', letterSpacing: '1px', marginBottom: '2px' }}>
                  SALE PRICE UPDATED
                </div>
                {saleUpdates.map((u, i) => (
                  <div key={i} style={{ fontSize: '10px', color: '#1e40af' }}>
                    {u.name}: ৳{Number(u.before).toFixed(2)} → ৳{Number(u.after).toFixed(2)}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Totals */}
          <div style={{ flex: '0 0 60%', padding: '8px 16px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <tbody>
                <tr>
                  <td style={{ padding: '2px 0', color: '#555' }}>Items Received</td>
                  <td style={{ padding: '2px 0', textAlign: 'right', fontWeight: '500' }}>{items.length}</td>
                </tr>
                <tr>
                  <td style={{ padding: '2px 0', color: '#555' }}>Total Quantity</td>
                  <td style={{ padding: '2px 0', textAlign: 'right', fontWeight: '500' }}>
                    {items.reduce((s, it) => s + Number(it.quantity || 0), 0)}
                  </td>
                </tr>
                <tr style={{ borderTop: `2px solid ${PRIMARY}` }}>
                  <td style={{ padding: '5px 0 3px', fontWeight: '800', color: PRIMARY, fontSize: '13px' }}>TOTAL VALUE</td>
                  <td style={{ padding: '5px 0 3px', textAlign: 'right', fontWeight: '800', color: PRIMARY, fontSize: '13px' }}>
                    {fmt(totalValue)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* ═══════════════════ TERMS / THANK YOU / SIGNATURES ═══════════════════ */}
        <div
          className="print-footer-section"
          style={{
            borderTop: `2px solid ${PRIMARY}`,
            display: 'grid',
            gridTemplateColumns: '1fr auto 1fr',
            alignItems: 'stretch',
          }}
        >
          {/* Terms */}
          <div style={{ padding: '8px 14px' }}>
            <div
              style={{
                fontWeight: '800',
                fontSize: '10px',
                color: PRIMARY,
                letterSpacing: '1.5px',
                paddingBottom: '4px',
                borderBottom: `2px solid ${PRIMARY}`,
                marginBottom: '6px',
                display: 'inline-block',
              }}
            >
              TERMS &amp; CONDITIONS
            </div>
            <ol
              style={{
                fontSize: '10px',
                color: '#444',
                paddingLeft: '16px',
                margin: 0,
                lineHeight: '1.5',
                listStyleType: 'decimal',
              }}
            >
              <li style={{ paddingLeft: '4px', marginBottom: '1px' }}>All items were inspected and counted before posting this note.</li>
              <li style={{ paddingLeft: '4px' }}>Report any damage or shortage to procurement within 24 hours of receipt.</li>
            </ol>
          </div>

          {/* Thank You — center column */}
          <div
            style={{
              borderLeft: '1px solid #dde3ef',
              borderRight: '1px solid #dde3ef',
              padding: '8px 20px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              minWidth: '180px',
            }}
          >
            <div
              style={{
                fontFamily: '"Brush Script MT", "Segoe Script", "Dancing Script", cursive',
                fontSize: '28px',
                color: PRIMARY,
                lineHeight: '1.1',
                whiteSpace: 'nowrap',
              }}
            >
              Thank You!
            </div>
            <div
              style={{
                width: '80%',
                height: '2px',
                background: GREEN,
                borderRadius: '2px',
                margin: '4px 0 5px',
              }}
            />
            <div
              style={{
                fontSize: '9px',
                color: GREEN,
                letterSpacing: '2px',
                fontWeight: '700',
              }}
            >
              FOR YOUR BUSINESS
            </div>
          </div>

          {/* Signatures */}
          <div
            style={{
              padding: '8px 14px',
              display: 'grid',
              gridTemplateColumns: '1fr 1px 1fr',
              alignItems: 'end',
              gap: '0',
            }}
          >
            {/* Received By */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 10px' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" style={{ marginBottom: '4px' }}>
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" stroke="#aaa" strokeWidth="1.5" strokeLinecap="round" />
                <circle cx="12" cy="7" r="4" stroke="#aaa" strokeWidth="1.5" />
              </svg>
              <div style={{ width: '100%', borderTop: '1.5px solid #999', paddingTop: '3px', textAlign: 'center' }}>
                <span style={{ fontSize: '10px', color: '#555', fontWeight: '500' }}>Received By</span>
              </div>
            </div>

            <div style={{ background: '#dde3ef', alignSelf: 'stretch' }} />

            {/* Authorized Signature */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 10px' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" style={{ marginBottom: '4px' }}>
                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" stroke="#aaa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <div style={{ width: '100%', borderTop: '1.5px solid #999', paddingTop: '3px', textAlign: 'center' }}>
                <span style={{ fontSize: '10px', color: '#555', fontWeight: '500' }}>Authorized Signature</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
