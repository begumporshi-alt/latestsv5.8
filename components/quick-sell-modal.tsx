'use client';

// Quick Sell — buy on demand from another shop, sell immediately to a
// standing customer, never stocked.
//
// One fast form creating its own invoice through the quick_sell_create RPC
// (atomic: product resolve/create + invoice + items + payments + journals).
// Non-stock items never touch inventory; the cost leg posts
// Dr 5000 COGS / Cr the "source purchase paid from" account. Offline, the
// same payload queues as a quick_sell.create outbox op.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Zap, Plus, Trash2, X, TriangleAlert as AlertTriangle, PackageOpen, UserPlus } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { loadVatSettings, computeVat, type VatSettings } from '@/lib/vat';
import { loadQuickSellSettings, DEFAULT_QUICK_SELL_SETTINGS, type QuickSellSettings } from '@/lib/quick-sell-settings';
import { checkCreditLimit, newReceivableFor, type CreditCheck } from '@/lib/credit-gate';
import { CreditConfirmDialog } from '@/components/credit-confirm-dialog';
import CustomerSearchInput, { type CustomerResult } from '@/components/ui/CustomerSearchInput';
import { networkMonitor } from '@/lib/offline/network';
import { enqueueOp } from '@/lib/offline/outbox';
import { fetchAll } from '@/lib/fetch-all';

interface Props {
  open: boolean;
  onClose: () => void;
  /** true from the POS (POS- numbering), false from the sales page (INV-) */
  isPos: boolean;
  /** called after a successful (or queued) quick sell */
  onCreated?: () => void;
}

interface QuickSellRow {
  key: string;
  product_id: string | null;
  name: string;
  unit: string;
  quantity: string;
  cost_price: string;
  sale_price: string;
  source_shop: string;
}

interface NonStockProduct {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  cost_price: number | string | null;
  sale_price: number | string | null;
}

interface PaymentMethod {
  code: string;
  name: string;
}

let rowKeySeq = 0;
const newRow = (): QuickSellRow => ({
  key: `qs-row-${++rowKeySeq}`,
  product_id: null,
  name: '',
  unit: 'pcs',
  quantity: '1',
  cost_price: '',
  sale_price: '',
  source_shop: '',
});

export function QuickSellModal({ open, onClose, isPos, onCreated }: Props) {
  const [customer, setCustomer] = useState<CustomerResult | null>(null);
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [rows, setRows] = useState<QuickSellRow[]>([newRow()]);
  const [vatSettings, setVatSettings] = useState<VatSettings | null>(null);
  const [vatApplied, setVatApplied] = useState(false);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [paymentTerm, setPaymentTerm] = useState<'full' | 'partial' | 'credit'>('full');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [partialAmount, setPartialAmount] = useState('');
  const [costMethod, setCostMethod] = useState('cash');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [qsSettings, setQsSettings] = useState<QuickSellSettings>(DEFAULT_QUICK_SELL_SETTINGS);
  const [submitting, setSubmitting] = useState(false);
  const [creditCheck, setCreditCheck] = useState<CreditCheck | null>(null);
  const [nonStock, setNonStock] = useState<NonStockProduct[]>([]);
  const [suggestFor, setSuggestFor] = useState<string | null>(null);
  const suggestRef = useRef<HTMLDivElement | null>(null);
  // Set when the user confirmed past the credit gate for THIS submission —
  // prevents the gate from re-firing on the immediate doSubmit() retry.
  const creditConfirmedRef = useRef(false);

  // ── data load on open ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    (async () => {
      const settings = await loadVatSettings(supabase);
      setVatSettings(settings);
      setVatApplied(settings.enabled && settings.default_on);
      setQsSettings(await loadQuickSellSettings(supabase));
      const { data: pm } = await supabase
        .from('payment_methods')
        .select('code, name')
        .eq('is_active', true)
        .order('name');
      setMethods((pm as PaymentMethod[]) || []);
      const prods = await fetchAll<NonStockProduct>(() =>
        supabase
          .from('products')
          .select('id, name, sku, unit, cost_price, sale_price')
          .eq('track_inventory', false)
          .eq('is_active', true)
          .order('name')
          .order('id')
          .range(0, 499)
      );
      setNonStock(prods || []);
    })();
  }, [open]);

  // ── suggestions dropdown ──────────────────────────────────────────────────
  useEffect(() => {
    if (!suggestFor) return;
    const handler = (e: MouseEvent) => {
      if (suggestRef.current && !suggestRef.current.contains(e.target as Node)) setSuggestFor(null);
    };
    setTimeout(() => window.addEventListener('mousedown', handler), 0);
    return () => window.removeEventListener('mousedown', handler);
  }, [suggestFor]);

  const suggestions = suggestFor
    ? nonStock
        .filter((p) => p.name.toLowerCase().includes(suggestFor.toLowerCase()))
        .slice(0, 8)
    : [];

  // ── totals ────────────────────────────────────────────────────────────────
  const subtotal = rows.reduce((s, r) => {
    const qty = parseFloat(r.quantity) || 0;
    const price = parseFloat(r.sale_price) || 0;
    return s + qty * price;
  }, 0);
  const vat = vatSettings ? computeVat(subtotal, vatSettings, vatApplied) : { taxAmount: 0, total: subtotal, net: subtotal };
  const grandTotal = vat.total;
  const totalCost = rows.reduce((s, r) => {
    const qty = parseFloat(r.quantity) || 0;
    const cost = parseFloat(r.cost_price) || 0;
    return s + qty * cost;
  }, 0);
  const cashToPay = paymentTerm === 'full' ? grandTotal : paymentTerm === 'partial' ? (parseFloat(partialAmount) || 0) : 0;

  const updateRow = (key: string, patch: Partial<QuickSellRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const resetForm = useCallback(() => {
    setCustomer(null);
    setShowAddCustomer(false);
    setRows([newRow()]);
    setPaymentTerm('full');
    setPaymentMethod('cash');
    setCostMethod('cash');
    setPartialAmount('');
    setReference('');
    setNotes('');
    setVatApplied(vatSettings ? vatSettings.enabled && vatSettings.default_on : false);
    setCreditCheck(null);
    creditConfirmedRef.current = false;
  }, [vatSettings]);

  // ── submit ────────────────────────────────────────────────────────────────
  const doSubmit = useCallback(async () => {
    if (submitting) return;
    if (!customer) {
      toast({ title: 'Customer required', description: 'Quick sells are for standing customers — pick one.', variant: 'destructive' });
      return;
    }
    const items = rows
      .filter((r) => r.name.trim() || r.product_id)
      .map((r) => ({
        product_id: r.product_id ?? undefined,
        name: r.name.trim() || undefined,
        unit: r.unit || 'pcs',
        // Qty field hidden (admin setting) = every line sells exactly 1 —
        // don't trust a stale typed value from before the setting loaded.
        quantity: qsSettings.show_qty ? parseFloat(r.quantity) || 0 : 1,
        cost_price: parseFloat(r.cost_price) || 0,
        sale_price: parseFloat(r.sale_price) || 0,
        source_shop: r.source_shop.trim() || undefined,
      }));
    if (items.length === 0 || items.some((i) => i.quantity <= 0 || i.sale_price < 0 || i.cost_price < 0)) {
      toast({ title: 'Fix the items', description: 'Every row needs a name, quantity > 0 and non-negative cost/price.', variant: 'destructive' });
      return;
    }
    if (paymentTerm === 'partial' && (!(parseFloat(partialAmount) > 0) || parseFloat(partialAmount) >= grandTotal)) {
      toast({ title: 'Invalid partial amount', description: 'Partial payment must be more than 0 and less than the total.', variant: 'destructive' });
      return;
    }

    // Credit gate (warn-and-confirm, same policy as POS).
    const newReceivable = newReceivableFor(grandTotal, cashToPay, 0);
    if (newReceivable > 0 && !creditConfirmedRef.current) {
      const check = await checkCreditLimit(customer.id, newReceivable);
      if (check) {
        setCreditCheck(check);
        return;
      }
    }
    setCreditCheck(null);

    const payload = {
      customer_id: customer.id,
      invoice_date: new Date().toISOString().slice(0, 10),
      is_pos: isPos,
      payment_term: paymentTerm,
      partial_amount: paymentTerm === 'partial' ? parseFloat(partialAmount) : undefined,
      items,
      tax_amount: vat.taxAmount,
      reference: reference.trim() || undefined,
      notes: notes.trim() || undefined,
      cash_payment: cashToPay > 0 ? { amount: cashToPay, method: paymentMethod } : undefined,
      cost_payment_method: costMethod,
      idempotency_key: crypto.randomUUID(),
    };

    setSubmitting(true);
    try {
      if (!networkMonitor.getState().online) {
        await enqueueOp('quick_sell.create', payload, `Quick Sell — ${customer.name}`);
        toast({
          title: 'Queued offline',
          description: `The quick sell for ${customer.name} will post automatically when you reconnect.`,
        });
        resetForm();
        onCreated?.();
        onClose();
        return;
      }

      const { data, error } = await supabase.rpc('quick_sell_create', { p_payload: payload });
      if (error) throw error;
      const res = (data || {}) as { status?: string; invoice_number?: string; products_created?: number };
      if (res.status === 'duplicate') {
        toast({ title: 'Already recorded', description: `This quick sell was already created as ${res.invoice_number}.` });
      } else {
        toast({
          title: `Quick sell ${res.invoice_number} created`,
          description: `${formatCurrency(grandTotal)}${res.products_created ? ` — ${res.products_created} new non-stock item(s) added to the catalog` : ''}`,
        });
      }
      resetForm();
      onCreated?.();
      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast({ title: 'Quick sell failed', description: message, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  }, [submitting, customer, rows, paymentTerm, partialAmount, grandTotal, cashToPay, vat.taxAmount, reference, notes, qsSettings, paymentMethod, costMethod, isPos, resetForm, onClose, onCreated]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[110] p-4">
        <div className="bg-white rounded-xl w-full max-w-3xl shadow-2xl max-h-[92vh] flex flex-col">
          {/* header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center shrink-0">
                <Zap className="w-5 h-5 text-amber-500" />
              </div>
              <div>
                <h3 className="text-base font-bold text-foreground">Quick Sell</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Bought on demand from another shop — sold immediately, never stocked
                </p>
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-muted transition" aria-label="Close quick sell">
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>

          {/* body */}
          <div className="px-5 py-4 overflow-y-auto space-y-4">
            {/* customer */}
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Customer (required)</label>
              <div className="flex gap-2">
                <div className="flex-1 min-w-0">
                  {customer ? (
                    <div className="flex items-center justify-between border border-border rounded-lg px-3 py-2.5 bg-muted/40">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground truncate">{customer.name}</p>
                        {customer.phone && <p className="text-xs text-muted-foreground">{customer.phone}</p>}
                      </div>
                      <button type="button" onClick={() => setCustomer(null)} className="text-xs text-blue-600 hover:underline shrink-0 ml-3">Change</button>
                    </div>
                  ) : (
                    <CustomerSearchInput onSelect={(c) => setCustomer(c)} placeholder="Search customer by name, code or phone..." />
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setShowAddCustomer(true)}
                  title="Add New Customer"
                  aria-label="Add new customer"
                  className="flex items-center justify-center gap-1.5 border border-blue-500 text-blue-600 rounded-lg px-3 py-2 text-sm hover:bg-blue-50 transition shrink-0"
                >
                  <UserPlus className="w-4 h-4" />
                  <span className="hidden sm:inline">New</span>
                </button>
              </div>
            </div>

            {/* items */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-muted-foreground">Items</label>
                <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <PackageOpen className="w-3 h-3" /> non-stock only — stocked products are sold normally
                </span>
              </div>
              {rows.map((r, idx) => (
                <div key={r.key} className="relative border border-border rounded-lg p-3 space-y-2 bg-muted/20">
                  {suggestFor === r.key && suggestions.length > 0 && (
                    <div ref={suggestRef} className="absolute left-3 right-3 top-full mt-1 z-20 bg-white border border-border rounded-lg shadow-lg max-h-52 overflow-y-auto">
                      {suggestions.map((s) => (
                        <button
                          key={s.id}
                          className="w-full text-left px-3 py-2 hover:bg-muted text-sm"
                          onClick={() => {
                            updateRow(r.key, {
                              product_id: s.id,
                              name: s.name,
                              unit: s.unit || 'pcs',
                              cost_price: r.cost_price === '' ? String(Number(s.cost_price) || 0) : r.cost_price,
                              sale_price: r.sale_price === '' ? String(Number(s.sale_price) || 0) : r.sale_price,
                            });
                            setSuggestFor(null);
                          }}
                        >
                          <span className="font-medium">{s.name}</span>
                          {s.sku && <span className="text-xs text-muted-foreground ml-2">{s.sku}</span>}
                          <span className="text-xs text-muted-foreground ml-2">
                            last cost {formatCurrency(Number(s.cost_price) || 0)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold text-muted-foreground w-5 shrink-0">#{idx + 1}</span>
                    <input
                      className="flex-1 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="Item name (type to reuse a non-stock item)"
                      value={r.name}
                      onChange={(e) => {
                        updateRow(r.key, { name: e.target.value, product_id: null });
                        setSuggestFor(e.target.value.trim() ? r.key : null);
                      }}
                    />
                    {rows.length > 1 && (
                      <button
                        onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                        className="p-2 rounded-lg text-red-500 hover:bg-red-50 transition shrink-0"
                        aria-label={`Remove item ${idx + 1}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  <div className={`grid grid-cols-2 ${qsSettings.show_qty ? 'sm:grid-cols-4' : 'sm:grid-cols-3'} gap-2`}>
                    {qsSettings.show_qty && (
                      <div>
                        <label className="block text-[11px] text-muted-foreground mb-1">Qty</label>
                        <input
                          type="number" min="0" step="any"
                          className="w-full border border-border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          value={r.quantity}
                          onChange={(e) => updateRow(r.key, { quantity: e.target.value })}
                        />
                      </div>
                    )}
                    <div>
                      <label className="block text-[11px] text-muted-foreground mb-1">Cost ৳ (paid to shop)</label>
                      <input
                        type="number" min="0" step="any"
                        className="w-full border border-border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        value={r.cost_price}
                        onChange={(e) => updateRow(r.key, { cost_price: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-muted-foreground mb-1">Sell price ৳</label>
                      <input
                        type="number" min="0" step="any"
                        className="w-full border border-border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        value={r.sale_price}
                        onChange={(e) => updateRow(r.key, { sale_price: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-muted-foreground mb-1">Bought from (optional)</label>
                      <input
                        className="w-full border border-border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="Shop name"
                        value={r.source_shop}
                        onChange={(e) => updateRow(r.key, { source_shop: e.target.value })}
                      />
                    </div>
                  </div>
                </div>
              ))}
              <button
                onClick={() => setRows((rs) => [...rs, newRow()])}
                className="flex items-center gap-1.5 text-sm text-blue-600 hover:underline font-medium"
              >
                <Plus className="w-4 h-4" /> Add another item
              </button>
            </div>

            {/* reference + vat */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Reference (optional)</label>
                <input
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Site / project name"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </div>
              <div className="flex items-end">
                {vatSettings?.enabled && (
                  <label className="flex items-center gap-2 text-sm text-foreground pb-2">
                    <input
                      type="checkbox"
                      className="w-4 h-4 accent-blue-600"
                      checked={vatApplied}
                      onChange={(e) => setVatApplied(e.target.checked)}
                    />
                    Apply VAT ({vatSettings.rate}%)
                  </label>
                )}
              </div>
            </div>

            {/* note */}
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Note (optional)</label>
              <textarea
                rows={2}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                placeholder="Anything worth remembering about this sale — saved on the invoice and shown on its view/print"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            {/* totals */}
            <div className="border border-border rounded-lg bg-muted/30 px-4 py-3 space-y-1.5 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="font-semibold">{formatCurrency(subtotal)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">VAT</span><span className="font-semibold">{formatCurrency(vat.taxAmount)}</span></div>
              <div className="flex justify-between border-t border-border pt-1.5"><span className="font-semibold">Total</span><span className="font-bold text-blue-700">{formatCurrency(grandTotal)}</span></div>
              <div className="flex justify-between text-xs text-muted-foreground"><span>Cost (paid to source shop)</span><span>{formatCurrency(totalCost)}</span></div>
              <div className="flex justify-between text-xs text-emerald-700"><span>Margin on this sale</span><span>{formatCurrency(subtotal - totalCost)}</span></div>
            </div>

            {/* payment */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Customer pays</label>
                <div className="flex gap-2">
                  {(['full', 'partial', 'credit'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setPaymentTerm(t)}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium border transition ${
                        paymentTerm === t ? 'bg-blue-600 text-white border-blue-600' : 'border-border text-foreground hover:bg-muted'
                      }`}
                    >
                      {t === 'full' ? 'Full' : t === 'partial' ? 'Partial' : 'Due'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Payment method</label>
                  <select
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                  >
                    {methods.map((m) => (
                      <option key={m.code} value={m.code}>{m.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
                    {paymentTerm === 'partial' ? 'Amount now ৳' : 'Amount now'}
                  </label>
                  <input
                    type="number" min="0" step="any" disabled={paymentTerm !== 'partial'}
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-muted disabled:text-muted-foreground"
                    value={paymentTerm === 'partial' ? partialAmount : paymentTerm === 'full' ? grandTotal.toFixed(2) : '0.00'}
                    onChange={(e) => setPartialAmount(e.target.value)}
                    readOnly={paymentTerm !== 'partial'}
                  />
                </div>
              </div>
            </div>

            {/* source purchase paid from */}
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
                Source purchase paid from <span className="font-normal text-muted-foreground">(where the money for the other shop came from)</span>
              </label>
              <select
                className="w-full sm:w-80 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                value={costMethod}
                onChange={(e) => setCostMethod(e.target.value)}
              >
                {methods.map((m) => (
                  <option key={m.code} value={m.code}>{m.name}</option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3 shrink-0" />
                Books the cost against this account the moment the sale is made — the item never enters inventory.
              </p>
            </div>
          </div>

          {/* footer */}
          <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-border shrink-0">
            <div className="text-sm">
              <span className="text-muted-foreground">To collect: </span>
              <span className="font-bold text-foreground">{formatCurrency(paymentTerm === 'credit' ? grandTotal : grandTotal - cashToPay)}</span>
              {paymentTerm !== 'credit' && <span className="text-muted-foreground"> due</span>}
            </div>
            <div className="flex gap-2">
              <button onClick={onClose} className="px-4 py-2.5 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-muted transition">
                Cancel
              </button>
              <button
                onClick={doSubmit}
                disabled={submitting}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white text-sm font-semibold transition"
              >
                <Zap className="w-4 h-4" />
                {submitting ? 'Recording...' : networkMonitor.getState().online ? 'Complete Quick Sell' : 'Queue Quick Sell'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {showAddCustomer && (
        <QuickSellAddCustomerModal
          onClose={() => setShowAddCustomer(false)}
          onSaved={(newCustomer) => {
            setCustomer(newCustomer);
            setShowAddCustomer(false);
          }}
        />
      )}

      {creditCheck && (
        <CreditConfirmDialog
          check={creditCheck}
          confirmLabel="Sell anyway"
          onConfirm={() => { creditConfirmedRef.current = true; setCreditCheck(null); doSubmit(); }}
          onGoBack={() => setCreditCheck(null)}
        />
      )}
    </>
  );
}


function QuickSellAddCustomerModal({ onClose, onSaved }: {
  onClose: () => void;
  onSaved: (customer: CustomerResult) => void;
}) {
  const [form, setForm] = useState({
    name: '',
    phone: '',
    email: '',
    address: '',
    type: 'retail' as 'retail' | 'contractor' | 'builder' | 'architect' | 'interior_designer' | 'corporate' | 'government',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('Customer name is required');
      return;
    }
    setSaving(true);
    setError('');

    const code = `CUST-${Date.now().toString().slice(-6)}`;
    const data = {
      code,
      name: form.name.trim(),
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      address: form.address.trim() || null,
      type: form.type,
      country: 'Bangladesh',
      is_active: true,
      credit_limit: 0,
      credit_days: 0,
      loyalty_points: 0,
      discount_percent: 0,
    };
    const customerFor = (id: string): CustomerResult => ({
      id,
      name: data.name,
      code: data.code,
      phone: data.phone ?? undefined,
      address: data.address ?? undefined,
      outstanding_balance: 0,
    });

    // Offline: queue the customer before the quick sell. The outbox applies
    // operations in order, so the queued invoice can safely reference this id.
    if (!networkMonitor.getState().online) {
      const id = crypto.randomUUID();
      try {
        await enqueueOp('customer.create', { id, data }, `New customer — ${data.name}`);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Offline storage error');
        setSaving(false);
        return;
      }
      toast({ title: 'Customer queued offline', description: `${data.name} will sync with your next order.` });
      onSaved(customerFor(id));
      onClose();
      return;
    }

    const { data: inserted, error: insertError } = await supabase
      .from('customers')
      .insert(data)
      .select('id')
      .single();

    if (insertError) {
      setError(insertError.message);
      setSaving(false);
      return;
    }

    toast({ title: 'Success', description: 'Customer added successfully' });
    onSaved(customerFor(inserted.id));
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[120] p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-bold flex items-center gap-2"><UserPlus className="w-4 h-4" />Add New Customer</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close add customer">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSave} className="p-4 space-y-3">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}
          <div>
            <label className="block text-xs font-medium mb-1">Customer Name *</label>
            <input
              required
              autoFocus
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="Enter customer name..."
              className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Phone</label>
              <input
                value={form.phone}
                onChange={e => setForm({ ...form, phone: e.target.value })}
                placeholder="Phone number..."
                className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Type</label>
              <select
                value={form.type}
                onChange={e => setForm({ ...form, type: e.target.value as typeof form.type })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none"
              >
                <option value="retail">Retail</option>
                <option value="contractor">Contractor</option>
                <option value="builder">Builder</option>
                <option value="architect">Architect</option>
                <option value="interior_designer">Interior Designer</option>
                <option value="corporate">Corporate</option>
                <option value="government">Government</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Email</label>
            <input
              type="email"
              value={form.email}
              onChange={e => setForm({ ...form, email: e.target.value })}
              placeholder="Email address..."
              className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Address</label>
            <textarea
              value={form.address}
              onChange={e => setForm({ ...form, address: e.target.value })}
              placeholder="Full address..."
              rows={2}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 resize-none"
            />
          </div>
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-border rounded-lg text-sm font-medium hover:bg-muted transition">Cancel</button>
            <button type="submit" disabled={saving} className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-50">
              {saving ? 'Saving...' : 'Add Customer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
