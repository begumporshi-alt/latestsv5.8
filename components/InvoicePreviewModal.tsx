'use client';

import { useEffect, useState } from 'react';
import { X, History, DollarSign, Printer, ChevronDown, Pencil, Ban, CreditCard, Copy, AlertTriangle, Check, Package } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatDate, isInvoiceOverdue } from '@/lib/format';
import { printNode } from '@/lib/print';
import PrintTemplate from './PrintTemplate';
import { useRouter } from 'next/navigation';
import type { Invoice, InvoiceStatus, Customer } from '@/lib/types';

interface InvoiceItem {
  product_id: string;
  product?: { name: string; sku?: string; unit?: string };
  quantity: number;
  unit_price: number;
  discount_percent: number;
  subtotal: number;
  unit_name?: string;
}

interface Payment {
  id: string;
  payment_number: string;
  payment_method: string;
  amount: number;
  payment_date: string;
}

interface CustomerOutstanding {
  total: number;
  invoiceDues: number;
  previousInvoiceDues: number;
  thisInvoiceDues: number;
  manualDues: number;
  storeCredit: number;
  advanceBalance: number;
}

export interface InvoicePreviewModalProps {
  docType: 'INVOICE' | 'RECEIPT';
  docNumber: string;
  docDate: string;
  dueDate?: string;
  status: string;
  company: {
    name: string;
    address?: string;
    phone?: string;
    email?: string;
    logo_url?: string;
  };
  customer: {
    name: string;
    code?: string;
    phone?: string;
    address?: string;
  };
  items: {
    product_name: string;
    product_sku?: string;
    quantity: number;
    unit_price: number;
    discount_percent: number;
    subtotal: number;
    unit_name?: string;
    product_id?: string | number;
  }[];
  subtotal: number;
  discountTotal?: number;
  cartDiscount?: number;
  cartDiscountPercent?: number;
  extraDiscount?: number;
  taxAmount: number;
  taxLabel?: string;
  shippingAmount?: number;
  hideDiscountPercent?: boolean;
  hideRate?: boolean;
  hideItemDiscount?: boolean;
  recalculatedSubtotal?: number;
  totalAmount: number;
  amountPaid?: number;
  balanceDue?: number;
  notes?: string;
  reference?: string;
  payments?: {
    payment_number: string;
    payment_date: string;
    amount: number;
    payment_method: string;
  }[];
  printRef: React.RefObject<HTMLDivElement>;
  onClose: () => void;
  showTabs?: boolean;
  showPrintOptions?: boolean;
  showCustomerOutstanding?: boolean;
  showActions?: boolean;
  invoiceId?: string;
  customer_id?: string;
  onEdit?: () => void;
  onCancel?: () => void;
  onRecordPayment?: () => void;
  onUpdateStatus?: (status: InvoiceStatus) => void;
  onCopyProductList?: () => void;
  onViewTab?: (tab: 'details' | 'history' | 'cost-history') => void;
  currentTab?: 'details' | 'history' | 'cost-history';
  customerOutstanding?: CustomerOutstanding | null;
  // Optional features for invoice previews
  isOfflinePending?: boolean;
  offlineTempNumber?: string;
  showProductLinks?: boolean;
  renderTabContent?: (tab: 'details' | 'history' | 'cost-history') => React.ReactNode;
}

export default function InvoicePreviewModal({
  docType,
  docNumber,
  docDate,
  dueDate,
  status,
  company,
  customer,
  items,
  subtotal,
  discountTotal = 0,
  cartDiscount = 0,
  cartDiscountPercent = 0,
  extraDiscount = 0,
  taxAmount = 0,
  taxLabel = 'VAT',
  shippingAmount = 0,
  // Print Options default to Hidden (matching the quotation): the Rate and
  // Discount % columns and the Item Discount row stay off the printed sheet
  // until switched back on from the Print Options menu. A caller can override
  // per-document by passing the prop explicitly.
  hideDiscountPercent: propHideDiscountPercent = true,
  hideRate: propHideRate = true,
  hideItemDiscount: propHideItemDiscount = true,
  recalculatedSubtotal,
  totalAmount,
  amountPaid = 0,
  balanceDue = 0,
  notes,
  reference,
  payments,
  printRef,
  onClose,
  showTabs = false,
  showPrintOptions = false,
  showCustomerOutstanding = false,
  showActions = false,
  invoiceId,
  customer_id,
  onEdit,
  onCancel,
  onRecordPayment,
  onUpdateStatus,
  onCopyProductList,
  onViewTab,
  currentTab = 'details',
  customerOutstanding: propCustomerOutstanding,
  isOfflinePending = false,
  offlineTempNumber,
  showProductLinks = false,
  renderTabContent,
}: InvoicePreviewModalProps) {
  const router = useRouter();
  const [hideDiscountPercent, setHideDiscountPercent] = useState(propHideDiscountPercent);
  const [hideRate, setHideRate] = useState(propHideRate);
  const [hideItemDiscount, setHideItemDiscount] = useState(propHideItemDiscount);
  const [printOptionsOpen, setPrintOptionsOpen] = useState(false);
  const [localCustomerOutstanding, setLocalCustomerOutstanding] = useState<CustomerOutstanding | null>(null);

  useEffect(() => {
    async function fetchCustomerOutstanding() {
      if (!customer_id) return;
      const { data: unpaidInvoices } = await supabase
        .from('invoices')
        .select('balance_due')
        .eq('customer_id', customer_id)
        .not('status', 'in', '("cancelled","refunded","paid")')
        .gt('balance_due', 0);
      const invoiceDues = (unpaidInvoices || []).reduce((s: number, i: any) => s + Number(i.balance_due || 0), 0);

      const { data: manualEntries } = await supabase
        .from('journal_entries')
        .select('id, total_debit')
        .eq('customer_id', customer_id)
        .eq('reference_type', 'receivable')
        .eq('is_posted', true);

      let manualDues = 0;
      if (manualEntries && manualEntries.length > 0) {
        for (const entry of manualEntries) {
          const { data: entryPayments } = await supabase
            .from('payments')
            .select('amount')
            .eq('reference_type', 'receivable')
            .eq('reference_id', entry.id)
            .eq('is_reversed', false);
          const paid = (entryPayments || []).reduce((s: number, p: any) => s + Number(p.amount || 0), 0);
          const outstanding = Number(entry.total_debit) - paid;
          if (outstanding > 0) manualDues += outstanding;
        }
      }

      const { data: credits } = await supabase
        .from('payments')
        .select('amount')
        .eq('customer_id', customer_id)
        .eq('payment_for', 'store_credit')
        .eq('is_reversed', false);
      const storeCredit = (credits || []).reduce((s: number, p: any) => s + Number(p.amount || 0), 0);

      const { data: advances } = await supabase
        .from('payments')
        .select('amount')
        .eq('customer_id', customer_id)
        .eq('payment_for', 'customer_advance')
        .eq('is_reversed', false);
      const advanceBalance = (advances || []).reduce((s: number, p: any) => s + Number(p.amount || 0), 0);

      setLocalCustomerOutstanding({
        total: invoiceDues + manualDues,
        invoiceDues,
        previousInvoiceDues: invoiceDues,
        thisInvoiceDues: 0,
        manualDues,
        storeCredit,
        advanceBalance,
      });
    }
    fetchCustomerOutstanding();
  }, [customer_id]);

  const customerOutstanding = propCustomerOutstanding ?? localCustomerOutstanding;
  const statusConfig: Record<string, { label: string; color: string; bg: string }> = {
    draft: { label: 'Draft', color: 'text-gray-600', bg: 'bg-gray-100' },
    sent: { label: 'On Credit', color: 'text-blue-600', bg: 'bg-blue-100' },
    partially_paid: { label: 'Partial', color: 'text-amber-600', bg: 'bg-amber-100' },
    paid: { label: 'Paid', color: 'text-green-600', bg: 'bg-green-100' },
    overdue: { label: 'Overdue', color: 'text-red-600', bg: 'bg-red-100' },
    cancelled: { label: 'Cancelled', color: 'text-gray-600', bg: 'bg-gray-100' },
    refunded: { label: 'Refunded', color: 'text-purple-600', bg: 'bg-purple-100' },
    refundable: { label: 'Refundable', color: 'text-teal-600', bg: 'bg-teal-100' },
  };

  const cfg = isInvoiceOverdue({ status: status as InvoiceStatus } as Invoice)
    ? { label: 'Overdue', color: 'text-red-600', bg: 'bg-red-100' }
    : (statusConfig[status] || statusConfig.draft);

  const balance = Number(balanceDue ?? (Number(totalAmount) - Number(amountPaid)));

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="print-modal bg-white rounded-2xl w-full max-w-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
        {/* Toolbar */}
        <div className="no-print flex flex-wrap items-center justify-between gap-3 px-6 py-3 border-b border-border sticky top-0 bg-white z-10">
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-sm font-semibold text-muted-foreground">{docType} Preview</span>
            {isOfflinePending && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-300 font-medium" title="Created on this device — will sync when back online">
                Queued offline — provisional number
              </span>
            )}
            {offlineTempNumber && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-300 font-medium" title="The temporary reference printed on the offline receipt before this invoice synced">
                Offline ref: {offlineTempNumber}
              </span>
            )}
            <div className="flex items-center gap-1 bg-muted/40 rounded-lg p-0.5">
              <button
                onClick={() => onViewTab?.('details')}
                className={`px-3 py-1 rounded-md text-xs font-medium transition ${
                  currentTab === 'details' ? 'bg-white text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Details
              </button>
              {showTabs && (
                <>
                  <button
                    onClick={() => onViewTab?.('history')}
                    className={`flex items-center gap-1 px-3 py-1 rounded-md text-xs font-medium transition ${
                      currentTab === 'history' ? 'bg-white text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <History className="w-3 h-3" />
                    History
                  </button>
                  <button
                    onClick={() => onViewTab?.('cost-history')}
                    className={`flex items-center gap-1 px-3 py-1 rounded-md text-xs font-medium transition ${
                      currentTab === 'cost-history' ? 'bg-white text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <DollarSign className="w-3 h-3" />
                    Cost Price History
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 w-full lg:w-auto">
            {showActions && onEdit && (
              <button
                onClick={onEdit}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-sm font-medium transition"
              >
                <Pencil className="w-3.5 h-3.5" />
                Edit
              </button>
            )}
            {showActions && onCancel && (
              <button
                onClick={onCancel}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition"
              >
                <Ban className="w-3.5 h-3.5" />
                Cancel
              </button>
            )}
            {onCopyProductList && (
              <button
                onClick={onCopyProductList}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium transition"
                title="Copy this invoice's product list"
              >
                <Copy className="w-3.5 h-3.5" />
                Copy Products
              </button>
            )}
            <button
              onClick={() => {
                if (printRef.current) {
                  try {
                    // printNode clones the invoice body into a fresh window and
                    // strips the fixed modal overlay, so the browser prints a
                    // single copy. window.print() on this live page repeats the
                    // position:fixed overlay on every page (duplicate copies).
                    printNode(printRef.current);
                  } catch (err: any) {
                    toast({
                      title: 'Print failed',
                      description: err?.message || 'Your browser may be blocking print. Please allow print permissions and try again.',
                      variant: 'destructive',
                    });
                  }
                }
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition"
            >
              <Printer className="w-3.5 h-3.5" />
              Print
            </button>
            {showPrintOptions && (
              <div className="relative">
                <button
                  onClick={() => setPrintOptionsOpen(v => !v)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-muted/40 text-muted-foreground hover:bg-muted/60 transition"
                >
                  <ChevronDown className="w-4 h-4" />
                  Print Options
                </button>
                {printOptionsOpen && (
                  <div className="absolute right-0 mt-2 w-64 bg-white border border-border rounded-lg shadow-lg p-2 z-50">
                    <button
                      onClick={() => setHideRate(v => !v)}
                      className="w-full flex items-center justify-between px-3 py-2 rounded-md text-sm hover:bg-muted transition"
                    >
                      <span>Rate Column</span>
                      {hideRate ? (
                        <span className="text-amber-700 font-medium">Hidden</span>
                      ) : (
                        <span className="text-green-700 font-medium">Visible</span>
                      )}
                    </button>
                    <button
                      onClick={() => setHideDiscountPercent(v => !v)}
                      className="w-full flex items-center justify-between px-3 py-2 rounded-md text-sm hover:bg-muted transition"
                    >
                      <span>Discount % Column</span>
                      {hideDiscountPercent ? (
                        <span className="text-amber-700 font-medium">Hidden</span>
                      ) : (
                        <span className="text-green-700 font-medium">Visible</span>
                      )}
                    </button>
                    <button
                      onClick={() => setHideItemDiscount(v => !v)}
                      className="w-full flex items-center justify-between px-3 py-2 rounded-md text-sm hover:bg-muted transition"
                    >
                      <span>Item Discount (under subtotal)</span>
                      {hideItemDiscount ? (
                        <span className="text-amber-700 font-medium">Hidden</span>
                      ) : (
                        <span className="text-green-700 font-medium">Visible</span>
                      )}
                    </button>
                  </div>
                )}
              </div>
            )}
            <button
              onClick={onClose}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-red-50 text-red-600 hover:bg-red-100 border border-red-200 transition"
            >
              <X className="w-4 h-4" />
              <span className="hidden sm:inline">Close</span>
            </button>
          </div>
        </div>

        {/* Print body */}
        {currentTab === 'details' ? (
          <div className="p-8" ref={printRef}>
            {/* Customer Account Summary Bar */}
            {showCustomerOutstanding && customerOutstanding && customerOutstanding.total > 0 && (
              <div className="no-print mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-xs font-bold text-red-700">Customer Account Summary</span>
                </div>
                <div className="flex flex-wrap gap-3 text-xs">
                  <span className="font-semibold text-red-700">Total Due: {formatCurrency(customerOutstanding.total)}</span>
                  {customerOutstanding.previousInvoiceDues > 0 && (
                    <span className="text-red-600">Previous Dues: {formatCurrency(customerOutstanding.previousInvoiceDues)}</span>
                  )}
                  {customerOutstanding.thisInvoiceDues > 0 && (
                    <span className="text-amber-600">This Invoice: {formatCurrency(customerOutstanding.thisInvoiceDues)}</span>
                  )}
                  {customerOutstanding.manualDues > 0 && (
                    <span className="text-amber-600">Manual: {formatCurrency(customerOutstanding.manualDues)}</span>
                  )}
                  {customerOutstanding.storeCredit > 0 && (
                    <span className="text-green-600">Store Credit: {formatCurrency(customerOutstanding.storeCredit)}</span>
                  )}
                  {customerOutstanding.advanceBalance > 0 && (
                    <span className="text-blue-600">Advance: {formatCurrency(customerOutstanding.advanceBalance)}</span>
                  )}
                </div>
              </div>
            )}

            <PrintTemplate
              docType={docType}
              docNumber={docNumber}
              docDate={docDate}
              dueDate={dueDate}
              status={cfg.label}
              company={company}
              customer={customer}
              items={items}
              subtotal={subtotal}
              discountTotal={discountTotal}
              cartDiscount={cartDiscount}
              cartDiscountPercent={cartDiscountPercent}
              extraDiscount={extraDiscount}
              taxAmount={taxAmount}
              taxLabel={taxLabel}
              shippingAmount={shippingAmount}
              hideDiscountPercent={hideDiscountPercent}
              hideRate={hideRate}
              hideItemDiscount={hideItemDiscount}
              recalculatedSubtotal={recalculatedSubtotal}
              totalAmount={totalAmount}
              amountPaid={amountPaid}
              balanceDue={balance}
              notes={notes}
              reference={reference}
              payments={payments}
            />

          {/* Product links (hidden on print) */}
          {showProductLinks && docType === 'INVOICE' && (
            <div className="no-print px-8 py-3 border-t border-border">
              <p className="text-xs text-muted-foreground mb-2">Products in this invoice (click to view details):</p>
              <div className="flex flex-wrap gap-2">
                {items.map((item, i) => (
                  <button
                    key={i}
                    onClick={() => item.product_id && router.push(`/inventory/${item.product_id}`)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-muted/40 hover:bg-blue-50 hover:text-blue-600 rounded-lg text-xs font-medium transition border border-transparent hover:border-blue-200"
                  >
                    <Package className="w-3 h-3" />
                    {item.product_name || 'Unknown'}
                  </button>
                ))}
              </div>
            </div>
          )}
          </div>
        ) : (
          <div className="p-6">
            {renderTabContent ? (
              renderTabContent(currentTab)
            ) : (
              <div className="text-center text-muted-foreground">Tab content not provided</div>
            )}
          </div>
        )}

        {/* Action buttons (hidden on print) */}
        {showActions && onRecordPayment && (
          <div className="no-print flex items-center justify-end gap-2 px-8 py-4 border-t border-border">
            <button
              onClick={onRecordPayment}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-semibold transition"
            >
              <CreditCard className="w-4 h-4" />
              Record Payment
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
