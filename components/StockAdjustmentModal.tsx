'use client';

/**
 * Stock adjustment modal: typed-reason quantity fixes and write-offs for a
 * single product, active or inactive, per warehouse with partial quantities.
 *
 * Both the online and the offline path send the SAME payload to the SAME
 * server RPC (sync_stock_adjustment) — online directly, offline through the
 * outbox — so FIFO consumption, journal routing and counter resync behave
 * identically either way.
 *
 * Reason routing (agreed accounting policy):
 *   quantity_correction → Dr 1200 / Cr 3900 (Opening Balance Equity) — a
 *     bookkeeping fix, never P&L.
 *   damaged | stolen | expired | destroyed | obsolete → Dr 5900 (Inventory
 *     Adjustment) / Cr 1200 — a genuine loss, P&L expense.
 */
import { useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { networkMonitor } from '@/lib/offline/network';
import { enqueueOp } from '@/lib/offline/outbox';
import { TriangleAlert, X } from 'lucide-react';
import type { Warehouse as WarehouseType } from '@/lib/types';

export const STOCK_ADJUSTMENT_REASONS = [
  { value: 'quantity_correction', label: 'Quantity correction', isLoss: false, hint: 'Recount / bookkeeping fix — posts to Opening Balance Equity (3900), not P&L.' },
  { value: 'damaged', label: 'Damaged', isLoss: true, hint: 'Goods damaged beyond sale — posts to Inventory Adjustment (5900) in P&L.' },
  { value: 'stolen', label: 'Stolen', isLoss: true, hint: 'Goods lost to theft — posts to Inventory Adjustment (5900) in P&L.' },
  { value: 'expired', label: 'Expired', isLoss: true, hint: 'Goods past usable life — posts to Inventory Adjustment (5900) in P&L.' },
  { value: 'destroyed', label: 'Destroyed', isLoss: true, hint: 'Goods destroyed (fire, flood, disposal) — posts to Inventory Adjustment (5900) in P&L.' },
  { value: 'obsolete', label: 'Obsolete (zero value)', isLoss: true, hint: 'Unsellable stock with zero recoverable value — posts to Inventory Adjustment (5900) in P&L.' },
] as const;

export type StockAdjustmentReason = (typeof STOCK_ADJUSTMENT_REASONS)[number]['value'];

interface AdjustmentRow {
  warehouseId: string;
  onHand: number;
  target: string;
}

export function StockAdjustmentModal({ product, warehouses, inventoryByWarehouse, pairValueFor, onClose, onDone }: {
  product: { id: string; name: string; sku: string; unit?: string | null; cost_price?: number | null };
  warehouses: WarehouseType[];
  inventoryByWarehouse: Record<string, Record<string, number>>;
  /** FIFO value of one product|warehouse pair (page's pairFifoValue). */
  pairValueFor: (warehouseId: string) => number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState<StockAdjustmentReason | ''>('');
  const [details, setDetails] = useState('');
  // target: for a correction this is the counted quantity; for a loss the
  // quantity lost. Both become one signed delta before submit.
  const [rows, setRows] = useState<AdjustmentRow[]>(() =>
    warehouses.map(w => ({
      warehouseId: w.id,
      onHand: inventoryByWarehouse[product.id]?.[w.id] || 0,
      target: '',
    }))
  );
  const [confirming, setConfirming] = useState(false);
  const [conflict, setConflict] = useState<{ message: string; onHandByWarehouse: Record<string, number> } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const reasonMeta = STOCK_ADJUSTMENT_REASONS.find(r => r.value === reason);
  const isLoss = !!reasonMeta && reasonMeta.isLoss;
  const unit = product.unit || 'pcs';

  const deltas = useMemo(() => rows.map(r => {
    const target = Number(r.target);
    if (r.target.trim() === '' || !Number.isFinite(target)) return { warehouseId: r.warehouseId, onHand: r.onHand, delta: 0 };
    return { warehouseId: r.warehouseId, onHand: r.onHand, delta: isLoss ? -Math.abs(target) : target - r.onHand };
  }), [rows, isLoss]);

  const activeDeltas = deltas.filter(d => d.delta !== 0);
  const lossUnits = activeDeltas.reduce((s, d) => s + Math.max(0, -d.delta), 0);
  const gainUnits = activeDeltas.reduce((s, d) => s + Math.max(0, d.delta), 0);
  // FIFO value of what leaves: scale the pair's layer value by the share
  // written off; stock without layers (or negative) falls back to cost price.
  const lossValue = activeDeltas.reduce((s, d) => {
    const lost = Math.max(0, -d.delta);
    if (lost <= 0 || d.onHand <= 0) return s + Math.max(0, lost) * Number(product.cost_price || 0);
    const fifo = pairValueFor(d.warehouseId);
    return s + (fifo > 0 ? fifo * (lost / d.onHand) : lost * Number(product.cost_price || 0));
  }, 0);

  const lossOverStock = deltas.filter(d => isLoss && -d.delta > d.onHand);
  const blockSubmit = !reason || activeDeltas.length === 0 || lossOverStock.length > 0;

  function setTarget(warehouseId: string, value: string) {
    setRows(rs => rs.map(r => (r.warehouseId === warehouseId ? { ...r, target: value } : r)));
  }

  function buildPayload() {
    // One UUID names the operation everywhere: sync_apply's idempotency claim,
    // the stock_movements reference and the journals the helpers post. A fresh
    // UUID is minted per submit attempt, so a retry after a conflict cannot be
    // mistaken for a replay of the rejected attempt.
    const opId = crypto.randomUUID();
    return {
      id: opId,
      idempotency_key: opId,
      product_id: product.id,
      reason_code: reason,
      reason_details: details.trim() || null,
      items: activeDeltas.map(d => ({
        warehouse_id: d.warehouseId,
        delta: d.delta,
        expected_on_hand: d.onHand,
        // Display-only (the server derives the authoritative cost); the
        // offline pending overlay shows it on the provisional movement row.
        unit_cost: Number(product.cost_price) || 0,
      })),
    };
  }

  async function handleSubmit() {
    setError('');
    const payload = buildPayload();
    setSaving(true);
    try {
      if (!networkMonitor.getState().online) {
        // Queued, not dropped: the FIFO consumption and journal post happen at
        // replay time, when the server can lock the real layers.
        await enqueueOp('stock.adjust', payload, `Stock ${isLoss ? 'write-off' : 'correction'} — ${product.name}`);
        toast({
          title: 'Adjustment queued offline',
          description: 'It will post to the ledger when you reconnect.',
        });
        onDone();
        return;
      }

      const { data, error: rpcError } = await supabase.rpc('sync_stock_adjustment', { p_payload: payload });
      if (rpcError) throw rpcError;
      const result = (data || {}) as { status?: string; message?: string; current_items?: { warehouse_id: string; on_hand: number }[] };
      if (result.status === 'conflict') {
        const onHand: Record<string, number> = {};
        for (const it of result.current_items || []) onHand[it.warehouse_id] = Number(it.on_hand);
        setRows(rs => rs.map(r => (onHand[r.warehouseId] !== undefined ? { ...r, onHand: onHand[r.warehouseId] } : r)));
        setConflict({ message: result.message || 'stock changed since this adjustment was prepared', onHandByWarehouse: onHand });
        setError('Stock changed while you were working — review the new on-hand figures and submit again.');
        return;
      }
      // synced or duplicate (a replayed retry) both mean the ledger is updated.
      toast({
        title: isLoss ? 'Stock written off' : 'Stock corrected',
        description: `${product.name} — ${activeDeltas.length} warehouse${activeDeltas.length === 1 ? '' : 's'} updated.`,
      });
      onDone();
    } catch (err: any) {
      setError(err.message || 'Failed to record the adjustment');
    } finally {
      setSaving(false);
    }
  }

  const labelFor = (wid: string) => warehouses.find(w => w.id === wid)?.name || 'Warehouse';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto relative">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-white z-10 rounded-t-2xl">
          <div>
            <h2 className="text-base font-bold">{confirming ? 'Confirm Stock Adjustment' : 'Adjust Stock'}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{product.name} · <span className="font-mono">{product.sku}</span></p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>

        {!confirming ? (
          <form
            onSubmit={e => { e.preventDefault(); if (!blockSubmit) setConfirming(true); }}
            className="p-6 space-y-4"
          >
            {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}

            <div>
              <label className="block text-xs font-medium mb-1">Reason *</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {STOCK_ADJUSTMENT_REASONS.map(r => (
                  <button
                    key={r.value}
                    type="button"
                    onClick={() => { setReason(r.value); setConflict(null); }}
                    className={`border rounded-lg px-3 py-2 text-sm text-left transition ${
                      reason === r.value
                        ? r.isLoss ? 'border-red-400 bg-red-50 text-red-700 font-semibold' : 'border-blue-400 bg-blue-50 text-blue-700 font-semibold'
                        : 'border-border hover:bg-muted text-foreground'
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              {reasonMeta && <p className="text-xs text-muted-foreground mt-2">{reasonMeta.hint}</p>}
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">Details (optional)</label>
              <input
                value={details}
                onChange={e => setDetails(e.target.value)}
                placeholder={isLoss ? 'e.g. 2 cartons water-damaged in storage' : 'e.g. annual physical count'}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>

            <div className="border border-border rounded-lg overflow-hidden">
              <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-muted/50 text-xs font-semibold text-muted-foreground">
                <div className="col-span-5">Warehouse</div>
                <div className="col-span-3 text-right">{isLoss ? 'Qty lost' : 'Counted qty'}</div>
                <div className="col-span-4 text-right">Change</div>
              </div>
              {rows.map(r => {
                const d = deltas.find(x => x.warehouseId === r.warehouseId)!;
                const over = isLoss && -d.delta > r.onHand;
                return (
                  <div key={r.warehouseId} className="grid grid-cols-12 gap-2 px-3 py-2 border-t border-border items-center">
                    <div className="col-span-5 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{labelFor(r.warehouseId)}</p>
                      <p className="text-xs text-muted-foreground">On hand: {r.onHand} {unit}</p>
                    </div>
                    <div className="col-span-3">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={r.target}
                        onChange={e => setTarget(r.warehouseId, e.target.value)}
                        placeholder="—"
                        className={`w-full border rounded-lg px-2 py-1.5 text-sm text-right ${over ? 'border-red-400' : 'border-border'} focus:outline-none focus:ring-2 focus:ring-blue-500/20`}
                      />
                    </div>
                    <div className="col-span-4 text-right text-sm">
                      {d.delta === 0 ? (
                        <span className="text-muted-foreground">no change</span>
                      ) : (
                        <span className={`font-semibold ${d.delta > 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {d.delta > 0 ? '+' : ''}{d.delta} {unit} → {isLoss ? r.onHand + d.delta : d.delta}
                        </span>
                      )}
                      {over && <p className="text-xs text-red-500 mt-0.5">more than on hand</p>}
                    </div>
                  </div>
                );
              })}
            </div>

            {isLoss && lossValue > 0 && (
              <div className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>
                  Estimated write-off value <strong>{formatCurrency(lossValue)}</strong> at FIFO cost — the exact amount is
                  taken from the oldest batch layers when this posts.
                </span>
              </div>
            )}
            {!isLoss && activeDeltas.some(d => d.delta < 0) && (
              <div className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>A correction that removes more stock than the ledger holds records the difference as an IOU (negative stock) — check the counted figures.</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-2">
              <button type="button" onClick={onClose} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
              <button
                type="submit"
                disabled={blockSubmit || saving}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60"
              >
                Review
              </button>
            </div>
          </form>
        ) : (
          <div className="p-6 space-y-4">
            {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}
            <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
              <TriangleAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {isLoss ? 'This posts a write-off to the P&L' : 'This corrects the stock ledger'}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {isLoss
                    ? 'FIFO layers are consumed and Inventory (1200) is credited against Inventory Adjustment (5900).'
                    : 'Inventory (1200) is adjusted against Opening Balance Equity (3900) — no profit or loss effect.'}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              {activeDeltas.map(d => (
                <div key={d.warehouseId} className="p-3 border border-border rounded-lg">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-sm font-medium">{labelFor(d.warehouseId)}</span>
                    <span className="text-sm">{d.onHand} → <span className={`font-semibold ${d.delta > 0 ? 'text-green-600' : 'text-red-600'}`}>{isLoss ? d.onHand + d.delta : d.delta}</span> {unit}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded ${d.delta > 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                      {d.delta > 0 ? `+${d.delta}` : d.delta}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {isLoss ? `write-off (${reason})` : 'quantity correction'}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <div className="p-3 bg-muted/30 rounded-lg text-sm space-y-1">
              <div><span className="text-muted-foreground">Reason: </span><span className="font-medium">{reasonMeta?.label}</span>{details.trim() && <span className="text-muted-foreground"> — {details.trim()}</span>}</div>
              {lossUnits > 0 && <div><span className="text-muted-foreground">Written off: </span>{lossUnits} {unit}{lossValue > 0 && <> · ≈ {formatCurrency(lossValue)} at FIFO cost</>}</div>}
              {gainUnits > 0 && <div><span className="text-muted-foreground">Added: </span>{gainUnits} {unit}</div>}
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button type="button" onClick={() => setConfirming(false)} disabled={saving} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Back to edit</button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={saving}
                className={`px-4 py-2 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60 ${isLoss ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}
              >
                {saving ? 'Saving...' : isLoss ? 'Confirm & Write Off' : 'Confirm & Save'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
