'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Printer, Link2Off } from 'lucide-react';
import PrintTemplate, { type PrintItem } from '@/components/PrintTemplate';
import { supabaseRaw } from '@/lib/supabase-raw';
import { formatDate } from '@/lib/format';

interface SharedDoc {
  type: 'QUOTATION' | 'INVOICE';
  document: any;
  customer: { name?: string; code?: string; phone?: string; address?: string } | null;
  items: PrintItem[];
  company: { name?: string; address?: string; phone?: string; email?: string; logo_url?: string; website?: string } | null;
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Viewed',
  accepted: 'Accepted',
  rejected: 'Rejected',
  expired: 'Expired',
  converted: 'Converted',
  partially_paid: 'Partial',
  paid: 'Paid',
  overdue: 'Overdue',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
};

export default function SharedDocumentPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token;
  const [state, setState] = useState<'loading' | 'invalid' | 'ready'>('loading');
  const [doc, setDoc] = useState<SharedDoc | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setState('invalid');
        return;
      }
      const { data, error } = await supabaseRaw.rpc('get_shared_document', { p_token: token });
      if (cancelled) return;
      if (error || !data) {
        setState('invalid');
        return;
      }
      setDoc(data as SharedDoc);
      setState('ready');
    })();
    return () => { cancelled = true; };
  }, [token]);

  if (state === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100 text-slate-500 text-sm">
        Loading document…
      </div>
    );
  }

  if (state === 'invalid' || !doc) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-100 gap-3 px-6 text-center">
        <Link2Off className="w-8 h-8 text-slate-400" />
        <p className="text-lg font-semibold text-slate-700">Link unavailable</p>
        <p className="text-sm text-slate-500 max-w-sm">
          This share link is invalid or has been disabled by the sender. Please ask for a new link.
        </p>
      </div>
    );
  }

  const d = doc.document;
  const isInvoice = doc.type === 'INVOICE';
  const company = doc.company?.name ? { ...doc.company, name: doc.company.name } : { name: '' };
  const customer = doc.customer?.name ? { ...doc.customer, name: doc.customer.name } : { name: '' };
  const status = STATUS_LABELS[d.status] || d.status;
  const amountPaid = isInvoice ? Number(d.amount_paid || 0) : 0;
  const balanceDue = isInvoice ? Number(d.total_amount || 0) - amountPaid : 0;

  return (
    <div className="min-h-screen bg-slate-100 py-6">
      <div className="no-print max-w-3xl mx-auto flex items-center justify-end gap-2 px-4 pb-3">
        <span className="mr-auto text-xs text-slate-500">
          Shared {doc.type === 'INVOICE' ? 'invoice' : 'quotation'} from {doc.company?.name || 'our company'}
        </span>
        <button
          onClick={() => window.print()}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition"
        >
          <Printer className="w-3.5 h-3.5" />
          Print / Save as PDF
        </button>
      </div>
      <div className="max-w-3xl mx-auto bg-white rounded-xl shadow-sm p-8 print:shadow-none print:rounded-none print:p-0 print:bg-white">
        <PrintTemplate
          docType={doc.type}
          docNumber={isInvoice ? d.invoice_number : d.quote_number}
          docDate={formatDate(isInvoice ? d.invoice_date : d.issue_date)}
          dueDate={isInvoice && d.due_date ? formatDate(d.due_date) : undefined}
          expiryDate={!isInvoice && d.expiry_date ? formatDate(d.expiry_date) : undefined}
          status={status}
          company={company}
          customer={customer}
          items={doc.items}
          subtotal={Number(d.subtotal || 0)}
          discountTotal={Number(d.discount_amount || 0)}
          taxAmount={Number(d.tax_amount || 0)}
          totalAmount={Number(d.total_amount || 0)}
          amountPaid={amountPaid}
          balanceDue={balanceDue}
          notes={d.notes || undefined}
        />
      </div>
    </div>
  );
}
