'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/format';
import { UnitInput } from '@/components/ui/unit-input';
import { toast } from '@/hooks/use-toast';
import { Search, Trash2, ShoppingCart, CreditCard, Banknote, Smartphone, CircleCheck as CheckCircle2, X, Camera, UserPlus, Wallet, Maximize2, Minimize2, ArrowRight, ArrowLeft, Receipt, History, SlidersHorizontal, ImagePlus, Package, Check, Clock, DollarSign, ChevronUp, ChevronDown, RotateCcw, Undo2, Layers, Printer, Keyboard, Tag, LayoutGrid, Warehouse } from 'lucide-react';
import type { ProductUnit } from '@/lib/types';
import { isMultiUnitEnabled, getDefaultSaleUnit, convertToBaseUnit, allowDecimalFor, clampSaleQty, normalizeUnitLabel } from '@/lib/unit-utils';
import { fetchLedgerStockFor, fetchOversellPolicy, computeShortfalls, shortfallDescription, type Shortfall } from '@/lib/oversell-gate';
import InvoicePreviewModal from '@/components/InvoicePreviewModal';
import { OversellConfirmDialog } from '@/components/oversell-confirm-dialog';
import { CreditConfirmDialog } from '@/components/credit-confirm-dialog';
import { checkCreditLimit, newReceivableFor, type CreditCheck } from '@/lib/credit-gate';
import {
  allocateCartLines, availableForNewAdd, fetchAllocatableBatches, fetchInventorySettings,
  ledgerQtyAllWarehouses, ledgerQtyForPair, pairKey, fmtQty, resolveWarehouse,
  stockedWarehouseIds, splitLineByWarehouse,
  DEFAULT_INVENTORY_SETTINGS,
  type AllocationResult, type AllocLineInput, type AllocatableBatch, type InventorySettings, type SubmitSplit,
} from '@/lib/batch-allocation';
import { InsufficientStockDialog, type InsufficientStockInfo } from '@/components/insufficient-stock-dialog';
import { loadVatSettings, computeVat, type VatSettings } from '@/lib/vat';
import { BatchAllocationEditor, type EditorBatch } from '@/components/batch-allocation-editor';
import { BatchAllocationViewer } from '@/components/batch-allocation-viewer';
import { WarehouseSelectModal } from '@/components/warehouse-select-modal';
import { useGlobalCart } from '@/hooks/use-global-cart';
import BarcodeScannerModal from '@/components/BarcodeScannerModal';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { networkMonitor } from '@/lib/offline/network';
import { cachedQuery, cacheGet, cachePut, cacheDelete, mutateCache, isNetworkError } from '@/lib/offline/cache';
import { readData } from '@/lib/offline/read-result';
import { CACHE_KEYS } from '@/lib/offline/keys';
import { enqueueOp } from '@/lib/offline/outbox';
import { fetchAll } from '@/lib/fetch-all';
import { REPLICA, replicaRows, buildPosSnapshotFromReplica, refreshReplicaTables, subscribeReplica } from '@/lib/offline/replica';
import { awaitPendingWrites } from '@/lib/offline/write-refresh';
import { runReplicaQuery, applyPendingOverlay } from '@/lib/offline/replica-query';
import type { LedgerStock } from '@/lib/oversell-gate';
import PrintTemplate from '@/components/PrintTemplate';
import { printNode } from '@/lib/print';
import { createPortal } from 'react-dom';
import { tokenizeSearch, applyIlikeTokens, matchesTokens, rankRows } from '@/lib/search';
import HighlightLabel from '@/components/ui/HighlightLabel';
import {
  buildPosSettlement, round2, type PosCollectMode, type PosSettlement,
  type PosOutstandingRow, type PosAdvanceRow,
} from '@/lib/pos-settlement';

// Snapshot of a completed charge, taken before the cart resets, so the
// receipt can be printed afterwards — online with the real number, offline
// with the device's temporary reference plus the provisional banner.
interface PosReceipt {
  number: string;
  offline: boolean;
  date: string;
  status: string;
  customer: { name: string; code?: string; phone?: string; email?: string; address?: string } | null;
  items: {
    product_name: string;
    product_sku?: string;
    quantity: number;
    unit_price: number;
    discount_percent: number;
    subtotal: number;
    unit_name?: string;
    warranty_months?: number;
  }[];
  subtotal: number;
  cartDiscount: number;
  cartDiscountPercent: number;
  extraDiscount: number;
  taxAmount: number;
  shipping: number;
  total: number;
  amountPaid: number;
  cashPaid: number;
  storeCredit: number;
  dueCollected: number;
  previousDue: number;
  /** advance-wallet money applied to THIS invoice (advance-first mode) */
  advanceApplied: number;
  /** everything credited to this invoice: cash + store credit + advance */
  paidTotal: number;
  paymentMethod: string;
  reference: string;
}

interface CartItem {
  id: string;
  name: string;
  sku: string;
  sale_price: number;
  cost_price: number;
  quantity: number;
  image_url?: string;
  inventory_item_id?: string;
  warehouse_id?: string;
  // Multi-warehouse allocation: when set (2+ ids), the line draws from all
  // of them (largest-stock first) and the submit splits it into one invoice
  // item per warehouse. warehouse_id stays the PRIMARY warehouse.
  warehouse_ids?: string[];
  stock_available: number;
  // Non-stock (quick-sell) products bypass the oversell gate — carried from
  // ProductData so the gate mapping can skip them.
  track_inventory?: boolean;
  warranty_months?: number;
  selected_unit?: ProductUnit;
  unit_price: number;
  base_quantity: number;
  // Decimal-allowed units (meter/foot/kg) accept fractional quantities;
  // everything else is floored to whole numbers at the input boundaries.
  allow_decimal?: boolean;
  unit?: string;
  discount_percent: number;
  // Manual batch allocation (spec §9): batchId → base-unit qty. Cleared on
  // any quantity/warehouse change so automatic allocation takes over again.
  allocOverride?: Record<string, number> | null;
  available_warehouses?: { warehouse_id: string; warehouse_name: string; stock: number; inventory_item_id: string }[];
}

type PaymentTerm = 'full' | 'partial' | 'credit';

interface ProductData {
  id: string;
  name: string;
  sku: string;
  sale_price: number;
  cost_price: number;
  image_url?: string;
  unit?: string;
  base_unit?: string;
  allow_decimal?: boolean;
  enable_multi_unit?: boolean;
  inventory_items: {
    id: string;
    warehouse_id: string;
    quantity_on_hand: number;
  }[];
  units?: ProductUnit[];
  // Non-stock (quick-sell) products bypass the oversell gate and all FIFO
  // handling — see lib/oversell-gate.ts and the 20260914100000 migration.
  track_inventory?: boolean;
  barcode?: string;
  warranty_months?: number;
}

/**
 * POS search: sanitised, order-independent, barcode-aware. The shared helpers
 * live in lib/search.ts — see .agents/skills/search-feature-robustness for
 * why each rule exists (the grammar injection that used to void the whole
 * search, missing barcode matching, and the response race).
 */
const POS_SEARCH_COLUMNS = ['name', 'sku', 'barcode'];

/** Relevance key for ranking search results (boundary hits outrank mid-word). */
function posRankColumns(p: ProductData): string[] {
  return [p.name, p.sku || '', p.barcode || ''];
}

/**
 * Every identifier a cashier can read off a customer record. `mobile` is a
 * DISTINCT column from `phone` and is sometimes the only number on file —
 * leaving it out made those customers unreachable by phone search.
 * `company_name` is what a B2B counter types; `email`/`tax_id` round out the
 * record (see the search-feature-robustness skill, failure mode 1).
 */
const CUSTOMER_SEARCH_COLUMNS = ['name', 'code', 'phone', 'mobile', 'company_name', 'email', 'tax_id'];

/** Relevance key for customer results — the columns the dropdown displays. */
function customerRankColumns(c: any): string[] {
  return [c.name || '', c.code || '', c.phone || '', c.mobile || '', c.company_name || ''];
}

/**
 * The dropdown renders one button per match with no virtualisation, and an
 * empty query matches every active customer (244 in this tenant, unbounded as
 * the book grows). Cap the render — the cashier types to narrow.
 */
const CUSTOMER_MATCH_LIMIT = 50;

const POS_GRID_PAGE_SIZE = 60;

const WALK_IN_CUSTOMER_ID = '00000000-0000-0000-0000-000000000001';

// Payment application ("Collect From") — the mode types, the settlement shape
// and the one pure builder the checkout preview and the charge path share —
// lives in lib/pos-settlement.ts so it can be unit-tested.

function ProductNameTooltip({ name, sku, className }: { name: string; sku?: string; className?: string }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <p className={className}>{name}</p>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p className="text-sm font-semibold leading-snug break-words">{name}</p>
          {sku ? <p className="text-xs text-muted-foreground mt-0.5">SKU: {sku}</p> : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default function POSPage() {
  const [products, setProducts] = useState<ProductData[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [vatSettings, setVatSettings] = useState<VatSettings>({ enabled: false, rate: 15, mode: 'exclusive', default_on: true });
  const [applyVat, setApplyVat] = useState(false);
  useEffect(() => {
    loadVatSettings(supabase).then(s => {
      setVatSettings(s);
      setApplyVat(s.enabled && s.default_on);
    });
    // Company header for the printed receipt. Offline this resolves from the
    // local replica / cached result via the wrapped client.
    supabase.from('app_settings').select('setting_value').eq('setting_key', 'company').maybeSingle()
      .then(({ data }: any) => setCompanySettings(data?.setting_value || null));
  }, []);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<string>('');
  const [walkInCustomerId, setWalkInCustomerId] = useState<string>(WALK_IN_CUSTOMER_ID);
  const [customers, setCustomers] = useState<any[]>([]);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [paymentMethods, setPaymentMethods] = useState<{ code: string; name: string }[]>([]);
  const [paymentTerm, setPaymentTerm] = useState<PaymentTerm>('full');
  const [partialAmount, setPartialAmount] = useState('');
  // Cash handed over at the till. Declared with its siblings because the
  // payment-application settlement (built below, next to grandTotal) reads it
  // on every render.
  const [amountPaid, setAmountPaid] = useState('');
  const [discount, setDiscount] = useState(0);
  const [extraDiscount, setExtraDiscount] = useState(0);
  const [shipping, setShipping] = useState(0);
  const [orderComplete, setOrderComplete] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [lastInvoiceNumber, setLastInvoiceNumber] = useState('');
  const [lastReceipt, setLastReceipt] = useState<PosReceipt | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);
  const [companySettings, setCompanySettings] = useState<any>(null);
  const receiptPrintRef = useRef<HTMLDivElement>(null);
  const orderCompleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [unitSelectorProduct, setUnitSelectorProduct] = useState<ProductData | null>(null);
  const [unitSelectorQty, setUnitSelectorQty] = useState('1');
  const [showScanner, setShowScanner] = useState(false);
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [brands, setBrands] = useState<{ id: string; name: string }[]>([]);
  const [selectedBrand, setSelectedBrand] = useState('');
  const [brandDropdownOpen, setBrandDropdownOpen] = useState(false);
  const [brandSearch, setBrandSearch] = useState('');
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [categoryDropdownOpen, setCategoryDropdownOpen] = useState(false);
  const [categorySearch, setCategorySearch] = useState('');
  const [storeCreditBalance, setStoreCreditBalance] = useState(0);
  const [applyStoreCredit, setApplyStoreCredit] = useState(false);
  // Previous-due collection alongside the current sale (Option A)
  const [dueCollectInput, setDueCollectInput] = useState('');
  const [customerOutstanding, setCustomerOutstanding] = useState<PosOutstandingRow[]>([]);
  // Bumped whenever the replica converges, so the customer-scoped reads below
  // (open invoices, advance wallets) re-run instead of showing the balance the
  // customer had when the cashier selected him. Both are single indexed reads.
  const [customerContextVersion, setCustomerContextVersion] = useState(0);
  const previousDueTotal = customerOutstanding.reduce((s, r) => s + (Number(r.balance_due) || 0), 0);
  const dueCollectAmount = Math.max(0, Math.min(parseFloat(dueCollectInput) || 0, previousDueTotal));
  // Payment application chooser + the customer's advance wallets (money we
  // already hold for him) — the "advance balance first" mode's source.
  const [collectMode, setCollectMode] = useState<PosCollectMode>('cash');
  const [customerAdvances, setCustomerAdvances] = useState<PosAdvanceRow[]>([]);
  const advanceBalance = customerAdvances.reduce((s, a) => s + (Number(a.balance) || 0), 0);
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().split('T')[0]);
  const [reference, setReference] = useState('');
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic sequence for product searches — drops out-of-order responses.
  const searchSeqRef = useRef(0);
  const productLoadRef = useRef(false);
  const productOffsetRef = useRef(0);
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreProducts, setHasMoreProducts] = useState(false);
  const { items: globalCartItems, clearCart: clearGlobalCart } = useGlobalCart();
  const globalCartConsumed = useRef(false);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string; code: string; is_default: boolean }[]>([]);
  // Automatic batch allocation: eligible batches for exactly the cart's
  // products are fetched once per cart change and the allocation is DERIVED
  // from the snapshot + cart contents on every render — so consolidating
  // lines, changing quantities, or removing items re-allocates automatically
  // and cart quantities act as in-session reservations (spec §4, §10). The
  // checkout gate re-fetches fresh totals at submit (spec §13).
  const [invSettings, setInvSettings] = useState<InventorySettings>(DEFAULT_INVENTORY_SETTINGS);
  const [allocBatches, setAllocBatches] = useState<Map<string, AllocatableBatch[]> | null>(null);
  const [shortfallConfirmOpen, setShortfallConfirmOpen] = useState(false);
  const [pendingShortfalls, setPendingShortfalls] = useState<Shortfall[]>([]);
  const [oversellBlocked, setOversellBlocked] = useState(false);
  const shortfallConfirmedRef = useRef(false);
  const [creditConfirmOpen, setCreditConfirmOpen] = useState(false);
  const [pendingCreditCheck, setPendingCreditCheck] = useState<CreditCheck | null>(null);
  const creditConfirmedRef = useRef(false);
  // Synchronous re-entrancy guard for processOrder — the `processing` state
  // alone can't stop double-clicks because it flips on only after the stock
  // and credit gates await, which can hang for seconds offline.
  const processingRef = useRef(false);
  // Idempotency key for the current checkout session. Every submission
  // attempt of the same charge (double-click race, retry after an ambiguous
  // failure) carries the same key; sync_invoice_create dedups on it so two
  // outbox items can never become two invoices for one intent.
  const chargeIntentIdRef = useRef<string>(crypto.randomUUID());
  const [insufficient, setInsufficient] = useState<{
    info: InsufficientStockInfo;
    product: ProductData;
    unit: ProductUnit;
    targetWarehouseId: string | undefined;
    targetWarehouseIds?: string[];
    availableWhs: CartItem['available_warehouses'];
  } | null>(null);
  const [viewingBatchLine, setViewingBatchLine] = useState<string | null>(null);
  const [pickingWarehouseLine, setPickingWarehouseLine] = useState<string | null>(null);
  const [editingAllocLine, setEditingAllocLine] = useState<string | null>(null);

  const defaultWarehouseId = warehouses.find(w => w.is_default)?.id ?? null;
  const strategy = invSettings.batch_allocation_method;

  // Stable identity for a cart line (engine input + expandable/override UI)
  function lineIdOf(item: CartItem): string {
    return `${item.id}|${item.selected_unit?.id || 'default'}|${item.warehouse_id ?? ''}`;
  }

  // Selected warehouses of a line (multi mode) — null when the line draws
  // from a single warehouse.
  function lineWarehouseIds(item: CartItem): string[] | null {
    const ids = (item.warehouse_ids || []).filter(Boolean);
    return ids.length > 0 ? ids : null;
  }

  const cartLineInputs: AllocLineInput[] = useMemo(
    () => cart.map(item => ({
      lineId: `${item.id}|${item.selected_unit?.id || 'default'}|${item.warehouse_id ?? ''}`,
      productId: item.id,
      warehouseId: item.warehouse_id,
      warehouseIds: lineWarehouseIds(item),
      baseQuantity: item.base_quantity,
      allocOverride: item.allocOverride,
    })),
    [cart]
  );

  // The allocation itself: a pure derivation, recomputed whenever the cart
  // or the batch snapshot changes. null when the batch lookup failed — the
  // UI then falls back to counter-based behavior, the same fail-open policy
  // as the oversell gate.
  const allocation: AllocationResult | null = useMemo(
    () => allocateCartLines(cartLineInputs, allocBatches, strategy, defaultWarehouseId),
    [cartLineInputs, allocBatches, strategy, defaultWarehouseId]
  );

  function lineAllocation(item: CartItem) {
    return allocation?.byLine.get(lineIdOf(item)) || null;
  }

  // Consume global cart items on mount (from header scanner)
  useEffect(() => {
    if (globalCartConsumed.current) return;
    if (globalCartItems.length === 0) return;
    globalCartConsumed.current = true;
    (async () => {
      const productIds = globalCartItems.map(i => i.id);
      const { data } = await supabase
        .from('products')
        .select(`id, name, sku, sale_price, cost_price, image_url, unit, base_unit, allow_decimal, enable_multi_unit, warranty_months,
          inventory_items(id, warehouse_id, quantity_on_hand),
          units:product_units(id, product_id, unit_name, unit_short, conversion_factor, is_base_unit, is_sale_unit, price, cost_price, is_active, sort_order)`)
        .in('id', productIds);
      if (data) {
        const productsById = new Map(data.map((p: any) => [p.id, p]));
        const newCartItems: CartItem[] = [];
        for (const gci of globalCartItems) {
          const p = productsById.get(gci.id) as ProductData | undefined;
          if (!p) continue;
          const invItems = p.inventory_items || [];
          const availableWhs = invItems
            .filter((i: any) => Number(i.quantity_on_hand) > 0)
            .map((i: any) => ({
              warehouse_id: i.warehouse_id,
              warehouse_name: warehouses.find(w => w.id === i.warehouse_id)?.name || i.warehouse_id,
              stock: Number(i.quantity_on_hand),
              inventory_item_id: i.id,
            }));
          const bestInv = availableWhs.length > 0 ? availableWhs.reduce((a, b) => a.stock > b.stock ? a : b) : null;
          const stockAvailableInBase = bestInv ? bestInv.stock : 0;
          // Same multi-warehouse default as addToCart: a scan of a product
          // stocked in 2+ warehouses draws from all of them, largest first.
          const scanWhIds = availableWhs.length > 1
            ? [...availableWhs].sort((a, b) => b.stock - a.stock).map(w => w.warehouse_id)
            : undefined;
          const unit = getDefaultSaleUnit(p as any);
          const unitPrice = gci.unit_price || unit.price || p.sale_price;
          newCartItems.push({
            id: p.id, name: p.name, sku: p.sku, sale_price: unitPrice,
            cost_price: unit.cost_price || (p.cost_price || 0) * (unit.conversion_factor || 1),
            quantity: gci.quantity, image_url: p.image_url,
            warranty_months: p.warranty_months,
            inventory_item_id: bestInv?.inventory_item_id, warehouse_id: bestInv?.warehouse_id,
            warehouse_ids: scanWhIds,
            stock_available: stockAvailableInBase, selected_unit: unit,
            allow_decimal: allowDecimalFor((p as any).allow_decimal, p.unit),
            unit: p.unit,
            unit_price: unitPrice, base_quantity: convertToBaseUnit(gci.quantity, unit),
            discount_percent: 0,
            available_warehouses: availableWhs,
          });
        }
        if (newCartItems.length > 0) {
          setCart(prev => [...newCartItems, ...prev]);
          toast({ title: 'Cart loaded', description: `${newCartItems.length} item(s) from scan added to cart` });
        }
        clearGlobalCart();
      }
    })();
  }, [globalCartItems]);

  useEffect(() => {
    loadProducts('');
    loadCustomers();
    // Reference data goes through the offline cache (small tables, long TTL):
    // online it refetches and refreshes the snapshot; offline it serves the
    // last copy so filters, warehouses and payment methods keep working.
    void loadCached(CACHE_KEYS.paymentMethods, 300_000, async () =>
      readData(await supabase.from('payment_methods').select('code, name').eq('is_active', true).order('sort_order'), [] as any[]))
      .then(d => { if (d && d.length > 0) setPaymentMethods(d); });
    void loadCached(CACHE_KEYS.brands, 300_000, async () =>
      readData(await supabase.from('brands').select('id, name').eq('is_active', true).order('name'), [] as any[]))
      .then(d => setBrands(d || []));
    void loadCached(CACHE_KEYS.categories, 300_000, async () =>
      readData(await supabase.from('categories').select('id, name').eq('is_active', true).order('name'), [] as any[]))
      .then(d => setCategories(d || []));
    void loadCached(CACHE_KEYS.warehouses, 300_000, async () =>
      readData(await supabase.from('warehouses').select('id, name, code, is_default').eq('is_active', true).order('is_default', { ascending: false }).order('name'), [] as any[]))
      .then(d => { if (d) setWarehouses(d); });
    supabase.from('app_settings').select('setting_value').eq('setting_key', 'product_defaults').maybeSingle()
      .then(({ data }) => {
        if (data?.setting_value?.default_image_url) setDefaultProductImage(data.setting_value.default_image_url);
      });
  }, []);

  // Small helper: cachedQuery with the state-setter lifted out. Returns null
  // when offline with no cached copy — callers keep their previous state.
  async function loadCached<T>(key: string, ttl: number, fetcher: () => Promise<T>): Promise<T | null> {
    try {
      const res = await cachedQuery(key, ttl, fetcher);
      return res.data;
    } catch {
      return null;
    }
  }

  // Load store credit balance when customer changes
  useEffect(() => {
    if (!selectedCustomer || selectedCustomer === walkInCustomerId) {
      setStoreCreditBalance(0);
      setApplyStoreCredit(false);
      return;
    }
    supabase
      .from('customer_store_credits')
      .select('balance')
      .eq('customer_id', selectedCustomer)
      .eq('status', 'active')
      // credits past their expiry date are no longer redeemable — exclude them
      // from the balance so the checkout never offers money that can't be used
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .then(({ data, error }) => {
        if (error) {
          // Offline: offer the last cached balance (the sync handler re-checks
          // live credits server-side before booking redemptions anyway).
          if (isNetworkError(error)) {
            void cacheGet<number>(`store-credits:${selectedCustomer}`).then(cached => {
              if (cached != null) setStoreCreditBalance(cached);
              else { setStoreCreditBalance(0); setApplyStoreCredit(false); }
            });
          } else {
            setStoreCreditBalance(0);
            setApplyStoreCredit(false);
          }
          return;
        }
        const total = (data || []).reduce((s: number, c: any) => s + Number(c.balance), 0);
        setStoreCreditBalance(total);
        void cachePut(`store-credits:${selectedCustomer}`, total);
        if (total === 0) setApplyStoreCredit(false);
      });
  }, [selectedCustomer, walkInCustomerId, customerContextVersion]);

  // Load previous outstanding invoices (oldest first) when the customer
  // changes — drives the optional "collect previous due" input at checkout.
  // The due is computed client-side with the same formula as the generated
  // balance_due column (total - amount_paid - bad_debt): offline this read is
  // served from the replica merged with queued payment ops, and the overlay
  // patches amount_paid/status but cannot rewrite a stored generated column —
  // so a queued due collection shrinks the offered due immediately. Status
  // filtering and oldest-first ordering are client-side for the same reason.
  // Failures degrade to "no collection offered"; the input resets on change.
  useEffect(() => {
    setDueCollectInput('');
    // A different customer means a different account: never carry a previously
    // chosen application mode into a new customer's checkout.
    setCollectMode('cash');
    if (!selectedCustomer || selectedCustomer === walkInCustomerId) {
      setCustomerOutstanding([]);
      setCustomerAdvances([]);
      return;
    }
    // Both the network read and the replica replay project these columns.
    const columns = 'id, invoice_number, status, invoice_date, created_at, total_amount, amount_paid, bad_debt_amount';
    // Server-side open-balance filter (same semantics as the old client-side
    // filter): the generated balance_due column already rounds with the app's
    // 0.01 epsilon, and non-open statuses are excluded in the query — a
    // frequent customer's full paid/cancelled history no longer downloads on
    // every selection.
    const STATUS_FILTER = '("cancelled","refunded","paid","draft")';
    let cancelled = false;
    void (async () => {
      const res: any = await supabase
        .from('invoices')
        .select(columns)
        .eq('customer_id', selectedCustomer)
        .not('status', 'in', STATUS_FILTER)
        .gt('balance_due', 0);
      let rows: any[] = Array.isArray(res?.data) ? res.data : [];
      if (res?.offline) {
        // The read fallback answers from the last cached copy of this exact
        // query, which can be far older than the hourly replica refresh —
        // and this figure decides how much cash the cashier takes. When it
        // fell back, prefer the replica (same chain, plus the queued-op
        // overlay); it declines with null if this device never replicated
        // invoices, leaving the cached copy in place.
        const local = await runReplicaQuery('invoices', [
          ['select', [columns]],
          ['eq', ['customer_id', selectedCustomer]],
          ['not', ['status', 'in', STATUS_FILTER]],
          ['gt', ['balance_due', 0]],
        ]);
        if (local && Array.isArray(local.data)) rows = local.data;
      }
      if (cancelled) return;
      setCustomerOutstanding(
        rows
          .map((i: any) => ({
            invoice_id: i.id,
            invoice_number: i.invoice_number,
            invoice_date: i.invoice_date || '',
            created_at: i.created_at || '',
            balance_due: Math.round((Number(i.total_amount) - Number(i.amount_paid) - Number(i.bad_debt_amount)) * 100) / 100,
          }))
          .filter((i) => i.balance_due > 0)
          .sort((a, b) => a.invoice_date.localeCompare(b.invoice_date) || a.created_at.localeCompare(b.created_at))
          .map(({ invoice_id, invoice_number, balance_due }) => ({ invoice_id, invoice_number, balance_due }))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedCustomer, walkInCustomerId, customerContextVersion]);

  // Load the customer's advance wallets (oldest first) — the money the shop
  // already holds for him, which the "advance balance first" mode spends.
  // Offline this is served from the replica plus the queued-op overlay (an
  // `advance.apply` queued moments ago has already shrunk the balance), so the
  // checkout can never offer advance money that is no longer there. The same
  // fallback rule as the dues read: when the wrapped read fell back to a stale
  // cache, prefer the replica's fresher copy.
  useEffect(() => {
    setCustomerAdvances([]);
    if (!selectedCustomer || selectedCustomer === walkInCustomerId) return;
    const columns = 'id, advance_number, balance, status, created_at';
    let cancelled = false;
    void (async () => {
      const res: any = await supabase
        .from('customer_advances')
        .select(columns)
        .eq('customer_id', selectedCustomer);
      let rows: any[] = Array.isArray(res?.data) ? res.data : [];
      if (res?.offline) {
        const local = await runReplicaQuery('customer_advances', [
          ['select', [columns]],
          ['eq', ['customer_id', selectedCustomer]],
        ]);
        if (local && Array.isArray(local.data)) rows = local.data;
      }
      if (cancelled) return;
      setCustomerAdvances(
        rows
          .filter((a: any) => a.status === 'active' && Number(a.balance) > 0)
          .sort((a: any, b: any) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
          .map((a: any) => ({
            advance_id: a.id,
            advance_number: a.advance_number,
            balance: round2(Number(a.balance) || 0),
          }))
      );
    })();
    return () => {
      cancelled = true;
    };
    // Re-runs on customerContextVersion so a wallet drained on another terminal
    // stops being offered here.
  }, [selectedCustomer, walkInCustomerId, customerContextVersion]);

  // Any cart change invalidates a prior "Sell anyway" confirmation.
  useEffect(() => { shortfallConfirmedRef.current = false; creditConfirmedRef.current = false; setOversellBlocked(false); }, [cart]);

  // Allocation strategy + partial-add policy (spec §3, §6) — loaded once.
  useEffect(() => {
    fetchInventorySettings().then(setInvSettings).catch(() => {});
  }, []);

  // Refresh eligible batches whenever the set of products in the cart
  // changes (bounded by cart size, so the 1000-row cap can't bite).
  const cartProductKey = Array.from(new Set(cart.map(i => i.id))).join(',');
  useEffect(() => {
    if (!cartProductKey) { setAllocBatches(null); return; }
    let stale = false;
    (async () => {
      try {
        const batches = await fetchAllocatableBatches(cartProductKey.split(','));
        if (!stale) setAllocBatches(batches);
      } catch {
        // Offline with no cached batch list — the editor stays hidden and the
        // sale falls back to counter stock; consumption is recorded on sync.
        if (!stale) setAllocBatches(null);
      }
    })();
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartProductKey]);

  useEffect(() => {
    const sequence = searchSeqRef;
    ++sequence.current;
    productLoadRef.current = false;
    setLoading(true);
    setLoadingMore(false);
    setHasMoreProducts(false);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => loadProducts(search), 250);
    return () => {
      ++sequence.current;
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, selectedBrand, selectedCategory]);

  // TTL for the full-product offline snapshot (also used by the inventory
  // page). The grid always renders from this snapshot locally; when the TTL
  // expires the snapshot is REBUILT from the locally replicated tables
  // (delta-refreshed every few minutes below), so staleness is bounded by
  // the replica cadence without re-downloading the catalog.
  const PRODUCT_SNAPSHOT_TTL = 10 * 60_000;

  // How often the POS-consumed replica tables converge in the background.
  const POS_REPLICA_REFRESH_MS = 10 * 60_000;

  // Build/refresh the full-catalog snapshot through the offline cache:
  // fresh within the TTL → instant local read, no work; stale → rebuild
  // from the replica stores (local) with a network fetchAll only when the
  // replica is still empty (first-ever visit). Returns the snapshot or null.
  async function refreshProductSnapshot(): Promise<ProductData[] | null> {
    try {
      const res = await cachedQuery<ProductData[]>(CACHE_KEYS.products, PRODUCT_SNAPSHOT_TTL, async () => {
        // The snapshot is rebuilt from the LOCAL replica. If a write has just
        // been committed to the server (a GRN raising stock, cost or sale
        // price), the replica is still a debounce-and-a-pull behind; reading
        // it now would cache pre-write values for the whole 10-minute TTL.
        // Converge first — a no-op when nothing is pending.
        await awaitPendingWrites();
        const fromReplica = await buildPosSnapshotFromReplica();
        if (fromReplica && fromReplica.length > 0) return fromReplica as ProductData[];
        return fetchAll(() => supabase
          .from('products')
          .select(`id, name, sku, barcode, sale_price, cost_price, image_url, unit, base_unit, allow_decimal, enable_multi_unit, track_inventory, warranty_months, brand_id, category_id,
            inventory_items(id, warehouse_id, quantity_on_hand),
            units:product_units(id, product_id, unit_name, unit_short, conversion_factor, is_base_unit, is_sale_unit, price, cost_price, is_active, sort_order)`)
          .eq('is_active', true)
          .order('name').order('id'));
      });
      return (res.data as ProductData[]) || null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve a scanned or typed code to a product.
   *
   * Two defects this replaces: the scan path queried `.eq('sku', code)` only —
   * while the modal's own copy says "Product SKU or barcode" — so scanning a
   * real barcode reported "not found"; and it went straight to the network, so
   * a scan failed offline.
   *
   * The full-catalog snapshot is local and complete, so try it first (exact
   * match on SKU *or* barcode, case-insensitive). Only a product the replica
   * has not pulled yet needs the server, and that query quotes its values
   * because a barcode is device-supplied text that can contain PostgREST
   * filter grammar (see lib/search.ts).
   */
  async function findProductByCode(code: string): Promise<ProductData | null> {
    const needle = String(code || '').trim();
    if (!needle) return null;
    const lower = needle.toLowerCase();

    const snapshot = await refreshProductSnapshot();
    const local = (snapshot || []).find(p => {
      const row = p as ProductData;
      return String(row.sku || '').toLowerCase() === lower
        || String(row.barcode || '').toLowerCase() === lower;
    });
    if (local) return local as ProductData;

    const safe = needle.replace(/["\\]/g, '');
    if (!safe) return null;
    const { data } = await supabase
      .from('products')
      .select(`id, name, sku, barcode, sale_price, cost_price, image_url, unit, base_unit, allow_decimal, enable_multi_unit, track_inventory, warranty_months, brand_id, category_id,
        inventory_items(id, warehouse_id, quantity_on_hand),
        units:product_units(id, product_id, unit_name, unit_short, conversion_factor, is_base_unit, is_sale_unit, price, cost_price, is_active, sort_order)`)
      .eq('is_active', true)
      .or(`sku.eq."${safe}",barcode.eq."${safe}"`)
      .maybeSingle();
    // The projection is narrower than `ProductUnit` (no created_at/updated_at)
    // — the cart only reads pricing and conversion fields, so bridge the type.
    return (data as unknown as ProductData) || null;
  }

  /**
   * Enter in the product box adds, it does not just filter.
   *
   * A keyboard-wedge barcode scanner is a keyboard: it types the code and
   * presses Enter into whatever has focus. With only an onChange, a scan into
   * the focused search box filtered the grid and the cashier still had to
   * click the tile — the scan "worked" but put nothing in the cart.
   *
   * Deliberately conservative. An exact SKU/barcode hit always wins, and it
   * does not read the debounced grid, so a fast scan can never add a stale
   * tile from the previous query. A single visible match is accepted only once
   * the load has settled.
   */
  async function addScannedOrSingleMatch() {
    const term = search.trim();
    if (!term || processing) return;
    const exact = await findProductByCode(term);
    if (exact) {
      handleProductClick(exact);
      setSearch('');
      return;
    }
    if (!loading && products.length === 1) {
      handleProductClick(products[0]);
      setSearch('');
    }
  }

  // Keep the replica tables the POS serves its catalog/stock/customers from
  // converged while the page is open. Delta pulls only download rows changed
  // since each table's cursor, so this costs a handful of zero-row requests
  // when nothing changed — never a catalog re-download. Advance wallets are
  // included because the offline checkout spends them: without this they would
  // only converge on the hourly full pass.
  useEffect(() => {
    const refreshPosTables = () => {
      if (document.visibilityState !== 'visible') return;
      void refreshReplicaTables(['Products', 'Stock counters', 'Product units', 'Customers', 'Customer advances']).catch(() => {});
    };
    const timer = setInterval(refreshPosTables, POS_REPLICA_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  // An open gallery and an open customer dropdown both render from React
  // state, so dropping a cache (a write on this device, or another device's
  // change arriving over Realtime) never reaches either one — the cashier
  // would keep seeing the old stock, cost, sale price or customer balance
  // until a manual reload. Rebuild both once the replica converges; the
  // debounce collapses the burst of per-table notifications one receipt emits.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeReplica(() => {
      if (!networkMonitor.getState().online) return;
      if (document.visibilityState !== 'visible') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        // Depth-aware: keep whatever the cashier has already paged through.
        void loadProducts(search, false, Math.max(productOffsetRef.current, POS_GRID_PAGE_SIZE));
        // The customer list feeds the picker's name/code/phone AND the "Due:"
        // badge, which comes from customers.outstanding_balance — recomputed
        // by the DB on every invoice and receivable payment.
        void loadCustomers();
        // Re-read this customer's open invoices and advance wallets — another
        // terminal may have collected a due or drained an advance while he sat
        // selected here.
        setCustomerContextVersion(v => v + 1);
      }, 1_500);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  /**
   * Load (or append) a page of the gallery.
   *
   * `pageSize` applies only to a non-append load, and only ever widens it: a
   * background refresh (replica change, the 10-minute pull) passes the number
   * of rows already on screen so the grid is rebuilt in place instead of
   * snapping back to the first page under a cashier who has paged through the
   * catalogue.
   */
  async function loadProducts(q: string, append = false, pageSize = POS_GRID_PAGE_SIZE) {
    if (append && (productLoadRef.current || loading || !hasMoreProducts)) return;
    productLoadRef.current = true;
    if (append) setLoadingMore(true);
    else {
      setLoading(true);
      setLoadingMore(false);
    }
    const seq = ++searchSeqRef.current;
    const offset = append ? productOffsetRef.current : 0;
    const size = append ? POS_GRID_PAGE_SIZE : Math.max(pageSize, POS_GRID_PAGE_SIZE);
    const tokens = tokenizeSearch(q);

    function applyPage(page: ProductData[], count: number | null) {
      if (seq !== searchSeqRef.current) return;
      productOffsetRef.current = offset + page.length;
      setProducts(prev => {
        if (!append) return page;
        const ids = new Set(prev.map(p => p.id));
        return [...prev, ...page.filter(p => !ids.has(p.id))];
      });
      setMatchCount(count);
      setHasMoreProducts(page.length >= POS_GRID_PAGE_SIZE && (count === null || offset + page.length < count));
    }

    // Filter + rank + paginate the full-catalog snapshot locally — the same
    // code path online and offline, so searching never touches the network.
    function applySnapshotPage(list: ProductData[]) {
      let filtered = list.filter(p => matchesTokens(p, POS_SEARCH_COLUMNS, tokens));
      if (selectedBrand) filtered = filtered.filter(p => (p as any).brand_id === selectedBrand);
      if (selectedCategory) filtered = filtered.filter(p => (p as any).category_id === selectedCategory);
      filtered = filtered.filter(p => (p as any).track_inventory !== false);
      filtered.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      const ranked = rankRows(filtered, posRankColumns, tokens);
      applyPage(ranked.slice(offset, offset + size), filtered.length);
    }

    async function loadCachedPage() {
      let cached = await cacheGet<ProductData[]>(CACHE_KEYS.products).catch(() => null);
      if (!cached || cached.length === 0) {
        const fromReplica = await buildPosSnapshotFromReplica();
        if (fromReplica && fromReplica.length > 0) {
          cached = fromReplica as ProductData[];
          void cachePut(CACHE_KEYS.products, cached);
        }
      }
      if (!cached || cached.length === 0) {
        throw new Error('Offline — no product cache yet. Open the POS once while online to build its offline product list.');
      }
      applySnapshotPage(cached);
    }

    try {
      if (!networkMonitor.getState().online) {
        await loadCachedPage();
        return;
      }

      // Online: serve the grid from the locally cached full-catalog snapshot
      // (refreshed on its own TTL, never per keystroke). Identical results to
      // a server query with none of the per-search downloads.
      const snapshot = await refreshProductSnapshot();
      if (snapshot && snapshot.length > 0) {
        applySnapshotPage(snapshot);
        return;
      }

      // No snapshot could be built (e.g. first-ever visit whose catalog fetch
      // failed) — fall back to a server-side grid page so the shelf isn't empty.
      let query = supabase
        .from('products')
        .select(`id, name, sku, barcode, sale_price, cost_price, image_url, unit, base_unit, allow_decimal, enable_multi_unit, track_inventory, warranty_months,
          inventory_items(id, warehouse_id, quantity_on_hand),
          units:product_units(id, product_id, unit_name, unit_short, conversion_factor, is_base_unit, is_sale_unit, price, cost_price, is_active, sort_order)`, { count: 'exact' })
        .eq('is_active', true)
        .eq('track_inventory', true)
        .order('name').order('id');

      query = applyIlikeTokens(query, POS_SEARCH_COLUMNS, tokens);
      if (selectedBrand) query = query.eq('brand_id', selectedBrand);
      if (selectedCategory) query = query.eq('category_id', selectedCategory);

      const { data, count, error } = await query.range(offset, offset + size - 1);
      if ((error && isNetworkError(error)) || (!error && !data)) {
        networkMonitor.markOffline();
        await loadCachedPage();
        return;
      }
      if (error) throw error;
      applyPage(rankRows((data || []) as ProductData[], posRankColumns, tokens), count ?? null);
    } catch (error) {
      if (seq !== searchSeqRef.current) return;
      if (!append) {
        setProducts([]);
        setMatchCount(null);
        setHasMoreProducts(false);
      }
      toast({
        title: append ? 'Could not load more products' : 'Could not load products',
        description: error instanceof Error ? error.message : (error as { message?: string })?.message,
        variant: 'destructive',
      });
    } finally {
      if (seq === searchSeqRef.current) {
        productLoadRef.current = false;
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }

  // Decrement the cached product snapshot (counter stock) and the
  // oversell-gate ledger snapshot by exactly what a sale drew. Shared by the
  // online checkout and the offline-queue path so a completed sale updates
  // the grid locally instead of triggering a full catalog re-download; the
  // next TTL refresh (or replica sync) self-corrects any FIFO/warehouse drift.
  async function applySaleToSnapshot(lines: Pick<CartItem, 'id' | 'base_quantity' | 'warehouse_id'>[]) {
    await mutateCache<ProductData[]>(CACHE_KEYS.products, list => {
      if (!list) return list;
      return list.map(p => {
        const sold = lines.filter(i => i.id === p.id);
        if (sold.length === 0) return p;
        const perWh: Record<string, number> = {};
        for (const l of sold) {
          const wh = l.warehouse_id || defaultWarehouseId;
          if (wh) perWh[wh] = (perWh[wh] || 0) + l.base_quantity;
        }
        let touched = false;
        const inventory_items = (p.inventory_items || []).map(inv => {
          if (perWh[inv.warehouse_id] != null) {
            touched = true;
            return { ...inv, quantity_on_hand: Number(inv.quantity_on_hand) - perWh[inv.warehouse_id] };
          }
          return inv;
        });
        return touched ? { ...p, inventory_items } : p;
      });
    });
    await mutateCache<LedgerStock>(CACHE_KEYS.gateStock, stock => {
      const base = stock ?? { byPair: {}, defaultWarehouseId };
      const byPair = { ...base.byPair };
      for (const l of lines) {
        const wh = l.warehouse_id || defaultWarehouseId;
        if (!wh) continue;
        const key = `${l.id}|${wh}`;
        byPair[key] = (byPair[key] ?? 0) - l.base_quantity;
      }
      return { ...base, byPair };
    });
  }

  // Quick Sell now lives in the global header — refresh the grid when a
  // quick sell completes while this page is mounted. An online quick sell
  // reduced stock server-side with no local patch, so force the snapshot to
  // rebuild (offline quick sells can't refetch — the grid self-corrects on
  // the next TTL refresh).
  useEffect(() => {
    const onQuickSellCreated = () => {
      if (networkMonitor.getState().online) void cacheDelete(CACHE_KEYS.products);
      loadProducts(search);
    };
    window.addEventListener('quick-sell:created', onQuickSellCreated);
    return () => window.removeEventListener('quick-sell:created', onQuickSellCreated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, selectedBrand, selectedCategory]);

  // Full customer list through the offline cache (also feeds the credit-gate
  // fallback and the walk-in resolution). Full rows so updated_at is captured
  // for conflict checks when a queued offline edit syncs. When the cache is
  // stale it rebuilds from the replica store (delta-refreshed above) — the
  // network fetch only seeds a device whose replica is still empty.
  async function loadCustomers() {
    try {
      const res = await cachedQuery<any[]>(CACHE_KEYS.customers, 60_000, async () => {
        // Layer the queued-outbox overlay over the replica: a name, phone,
        // code, credit-limit or active-flag edit queued offline lives only in
        // the outbox until the sync drains, and a raw replica read would keep
        // serving the pre-edit row to the picker and the credit gate.
        const local = await applyPendingOverlay('customers', await replicaRows<any>(REPLICA['Customers']));
        const active = local
          .filter((c: any) => c.is_active)
          .sort((a: any, b: any) =>
            String(a.name || '').localeCompare(String(b.name || '')) || String(a.id).localeCompare(String(b.id)));
        if (active.length > 0) return active;
        return fetchAll(() => supabase.from('customers').select('*').eq('is_active', true).order('name').order('id'));
      });
      setCustomers(res.data || []);
      const walkIn = (res.data || []).find((c: any) => (c.name || '').toLowerCase().includes('walk'));
      if (walkIn) {
        setWalkInCustomerId(walkIn.id);
        setSelectedCustomer(prev => (prev === WALK_IN_CUSTOMER_ID || prev === '') ? walkIn.id : prev);
      }
    } catch {
      // Last resort: the local database replica.
      const replicaCustomers = await applyPendingOverlay('customers', await replicaRows<any>(REPLICA['Customers']));
      if (replicaCustomers.length > 0) {
        // Same ordering as the primary path — the dropdown caps its render, so
        // an unsorted pool would show an arbitrary 50.
        setCustomers(replicaCustomers
          .filter((c: any) => c.is_active)
          .sort((a: any, b: any) =>
            String(a.name || '').localeCompare(String(b.name || '')) || String(a.id).localeCompare(String(b.id))));
        const walkIn = replicaCustomers.find((c: any) => (c.name || '').toLowerCase().includes('walk'));
        if (walkIn) {
          setWalkInCustomerId(walkIn.id);
          setSelectedCustomer(prev => (prev === WALK_IN_CUSTOMER_ID || prev === '') ? walkIn.id : prev);
        }
      } else {
        setCustomers([]);
      }
    }
  }

  const filteredProducts = products;

  function getStockInBaseUnits(product: ProductData): number {
    return product.inventory_items?.reduce((s: number, i: any) => s + Number(i.quantity_on_hand), 0) || 0;
  }

  // Product-level availability for the grid badge (spec §18): batch-ledger
  // truth minus everything already reserved in the cart, falling back to the
  // counter when the product has no batch rows at all (legacy data) or the
  // batch lookup failed (fail open, same policy as the oversell gate).
  // Negative values (IOU / oversold) are shown as-is so the badge matches
  // the products page and quotation gallery.
  function getProductAvailable(product: ProductData): { available: number; batches: number } {
    const cartQty = cart.filter(c => c.id === product.id).reduce((s, c) => s + c.base_quantity, 0);
    if (allocBatches && allocBatches.has(product.id)) {
      return {
        available: ledgerQtyAllWarehouses(product.id, allocBatches) - cartQty,
        batches: (allocBatches.get(product.id) || []).length,
      };
    }
    return { available: getStockInBaseUnits(product) - cartQty, batches: 0 };
  }

  // Batch-ledger qty this pair can still take (cart reservations already
  // subtracted). null → no batch data for this product → caller falls back
  // to the counter.
  function pairAvailable(productId: string, warehouseId?: string | null): number | null {
    if (!allocBatches || !allocBatches.has(productId)) return null;
    return availableForNewAdd(productId, warehouseId, allocation, defaultWarehouseId);
  }

  // Warehouse with the most eligible batch stock (counter as tiebreaker).
  function pickBestWarehouse(productId: string, availableWhs: { warehouse_id: string; stock: number }[]): string | undefined {
    if (availableWhs.length === 0) return undefined;
    if (allocBatches && allocBatches.has(productId)) {
      let best: string | undefined;
      let bestQty = -1;
      for (const wh of availableWhs) {
        const q = ledgerQtyForPair(productId, wh.warehouse_id, allocBatches, defaultWarehouseId);
        if (q > bestQty) { bestQty = q; best = wh.warehouse_id; }
      }
      if (bestQty > 0) return best;
    }
    return availableWhs.reduce((a, b) => (a.stock > b.stock ? a : b)).warehouse_id;
  }

  // What a multi-warehouse line can still take across ALL its selected
  // warehouses (single-warehouse lines keep the per-pair ceiling). Null when
  // no batch snapshot exists — the counter fallback applies instead.
  function lineAvailableExtra(item: CartItem): number | null {
    const ids = lineWarehouseIds(item);
    if (!ids) return pairAvailable(item.id, item.warehouse_id);
    if (!allocBatches || !allocBatches.has(item.id) || !allocation) return null;
    return ids.reduce((s, wh) => s + availableForNewAdd(item.id, wh, allocation, defaultWarehouseId), 0);
  }

  // Expand a cart line into the invoice items it becomes at submit — thin
  // wrapper over the shared splitter, fed from the derived allocation.
  function splitLineForSubmit(item: CartItem): SubmitSplit[] {
    return splitLineByWarehouse({
      warehouse_id: item.warehouse_id,
      warehouse_ids: lineWarehouseIds(item),
      quantity: item.quantity,
      base_quantity: item.base_quantity,
      unit_price: item.unit_price,
      discount_percent: item.discount_percent,
      conversion_factor: item.selected_unit?.conversion_factor,
    }, lineAllocation(item));
  }

  // Pure cart mutation: merge into the product+unit+warehouse line, or push
  // a new line. Quantity changes clear any manual allocation override so
  // automatic allocation takes over again (spec §11).
  function performAdd(product: ProductData, unit: ProductUnit, qty: number, warehouseId: string | undefined, availableWhs: CartItem['available_warehouses'], warehouseIds?: string[]) {
    const unitPrice = unit.price || product.sale_price;
    setCart(prev => {
      const idx = prev.findIndex(i => i.id === product.id && i.selected_unit?.id === unit.id && (i.warehouse_id ?? '') === (warehouseId ?? ''));
      if (idx >= 0) {
        const existing = prev[idx];
        const newQty = existing.quantity + qty;
        const updated = [...prev];
        updated[idx] = { ...existing, quantity: newQty, base_quantity: convertToBaseUnit(newQty, unit), allocOverride: null };
        return updated;
      }
      const bestInv = availableWhs?.find(w => w.warehouse_id === warehouseId);
      return [{
        id: product.id,
        name: product.name,
        sku: product.sku,
        sale_price: unitPrice,
        cost_price: unit.cost_price || (product.cost_price || 0) * (unit.conversion_factor || 1),
        quantity: qty,
        image_url: product.image_url,
        warranty_months: product.warranty_months,
        inventory_item_id: bestInv?.inventory_item_id,
        warehouse_id: warehouseId,
        warehouse_ids: warehouseIds && warehouseIds.length > 1 ? warehouseIds : undefined,
        stock_available: bestInv?.stock ?? 0,
        track_inventory: product.track_inventory,
        allow_decimal: allowDecimalFor(product.allow_decimal, product.unit),
        unit: product.unit,
        selected_unit: unit,
        unit_price: unitPrice,
        base_quantity: convertToBaseUnit(qty, unit),
        discount_percent: 0,
        allocOverride: null,
        available_warehouses: availableWhs,
      }, ...prev];
    });
  }

  function addToCart(product: ProductData, selectedUnit?: ProductUnit, requestedQty?: number) {
    const allowDecimal = allowDecimalFor(product.allow_decimal, product.unit);
    const qty = Math.max(clampSaleQty(requestedQty ?? 1, allowDecimal), 0);
    if (qty <= 0) return;
    const unit = selectedUnit || getDefaultSaleUnit(product as any);
    const addBaseQty = convertToBaseUnit(qty, unit);

    const invItems = product.inventory_items || [];
    const availableWhs = invItems
      .filter((i: any) => Number(i.quantity_on_hand) > 0)
      .map((i: any) => ({
        warehouse_id: i.warehouse_id,
        warehouse_name: warehouses.find(w => w.id === i.warehouse_id)?.name || i.warehouse_id,
        stock: Number(i.quantity_on_hand),
        inventory_item_id: i.id,
      }));

    // Merge target: an existing line for the same product+unit keeps its
    // warehouses (spec §12 — update the line, don't duplicate). A NEW line
    // defaults to ALL stocked warehouses (largest first) when the product
    // lives in 2+ of them, so a sale draws from every warehouse instead of
    // one; the warehouse modal can narrow the selection.
    const existing = cart.find(i => i.id === product.id && i.selected_unit?.id === unit.id);
    const stockedIds = existing ? [] : stockedWarehouseIds(product.id, availableWhs, allocBatches, defaultWarehouseId);
    const targetWarehouseIds = stockedIds.length > 1 ? stockedIds : undefined;
    const targetWarehouseId = existing?.warehouse_id
      ?? targetWarehouseIds?.[0]
      ?? pickBestWarehouse(product.id, availableWhs);

    // Ceiling in base units: batch-ledger available (cart reservations
    // subtracted) when batch data exists for the product — combined across
    // all selected warehouses for multi-warehouse lines — otherwise the
    // counter stock (legacy products).
    const batchKnown = !!allocBatches && allocBatches.has(product.id);
    const combinedSelected = targetWarehouseIds || [targetWarehouseId || defaultWarehouseId];
    const maxTotalBase = batchKnown
      ? combinedSelected.reduce((s, wh) => s + (allocation?.availableByPair.get(pairKey(product.id, wh)) ?? 0), 0)
      : combinedSelected.reduce((s, wh) => s + (availableWhs.find(w => w.warehouse_id === wh)?.stock ?? 0), 0);

    const existingBase = existing?.base_quantity ?? 0;
    const newTotalBase = existingBase + addBaseQty;

    if (newTotalBase > maxTotalBase + 1e-9) {
      const availableBase = Math.max(0, maxTotalBase - existingBase);
      if (availableBase <= 1e-9) {
        // With "Allow selling beyond stock" ON, a 0-stock product is a
        // deliberate add — the submit gate polices the shortfall (confirm
        // dialog; DB hard-block when the setting is OFF).
        if (!invSettings.allow_oversell) {
          toast({ title: 'Out of stock', description: `${product.name} has nothing allocatable across its batches`, variant: 'destructive' });
          return;
        }
        performAdd(product, unit, qty, targetWarehouseId, availableWhs, targetWarehouseIds);
        setUnitSelectorProduct(null);
        return;
      }
      // Insufficient stock (spec §6): offer what exists — behavior is
      // configurable via Settings → Inventory → allow_partial_add.
      const cf = unit.conversion_factor || 1;
      setInsufficient({
        info: {
          productName: product.name,
          requested: qty,
          available: availableBase / cf,
          unitName: unit.unit_short || unit.unit_name,
        },
        product,
        unit,
        targetWarehouseId,
        targetWarehouseIds,
        availableWhs,
      });
      setUnitSelectorProduct(null);
      return;
    }

    performAdd(product, unit, qty, targetWarehouseId, availableWhs, targetWarehouseIds);
    setUnitSelectorProduct(null);
  }

  function handleProductClick(product: ProductData) {
    if (isMultiUnitEnabled(product as any)) {
      setUnitSelectorQty('1');
      setUnitSelectorProduct(product);
    } else {
      addToCart(product);
    }
  }

  // keepAtZero: keyboard qty nudges may land on 0 without dropping the line —
  // removing a line is an explicit gesture (Esc or the line's X button), and
  // openCheckout prunes zero lines so they can never be charged. The qty input
  // (typing or the native spinner) behaves the same way — see
  // updateCartQuantity.
  function updateQty(id: string, unitId: string | undefined, delta: number, keepAtZero = false) {
    setCart(prev => prev.map(i => {
      if (i.id !== id || i.selected_unit?.id !== unitId) return i;
      const allowDecimal = allowDecimalFor(i.allow_decimal, i.unit);
      const newQty = clampSaleQty(Math.max(0, i.quantity + delta), allowDecimal);
      const newBaseQty = i.selected_unit ? convertToBaseUnit(newQty, i.selected_unit) : newQty;
      // Ceiling: what the line's warehouse selection can still take beyond
      // this line's own reservation (batch ledger truth; counter fallback
      // without data). Multi-warehouse lines combine all selected pairs.
      const extra = lineAvailableExtra(i);
      const maxBase = extra !== null ? i.base_quantity + extra : i.stock_available;
      // With overselling allowed the ceiling is advisory — the submit gate
      // (and the DB, when the setting is OFF) do the enforcing.
      if (newBaseQty > maxBase + 1e-9 && !invSettings.allow_oversell) {
        toast({ title: 'Stock limit', description: `Only ${fmtQty(maxBase)} base units available`, variant: 'destructive' });
        return i;
      }
      return { ...i, quantity: newQty, base_quantity: newBaseQty, allocOverride: null };
    }).filter(i => keepAtZero || i.quantity > 0));
  }

  // Single open path for checkout: zero-quantity lines (left by keyboard
  // nudges) are pruned here, so no charge payload ever sees one.
  function openCheckout() {
    if (cart.length === 0 || processing) return;
    const chargeable = cart.filter(i => i.quantity > 0);
    if (chargeable.length === 0) {
      toast({ title: 'Nothing to charge', description: 'Every line is at quantity 0 — raise a quantity or remove the lines.' });
      return;
    }
    if (chargeable.length !== cart.length) setCart(chargeable);
    setShowCheckout(true);
  }

  // The editable controls of a cart line, in on-screen order. WH and Batch
  // only exist when their picker buttons render.
  function cartLineFields(item: CartItem): { kind: 'price' | 'disc' | 'wh' | 'batch' | 'qty' }[] {
    const la = lineAllocation(item);
    const multiWarehouse = (item.available_warehouses || []).length > 1;
    const batchWarnCount = (la && la.shortfall > 1e-9 ? 1 : 0) + (la && la.overrideInvalid ? 1 : 0);
    const hasBatchButton = !!la && (la.allocations.length > 0 || batchWarnCount > 0);
    return [
      { kind: 'price' as const },
      { kind: 'disc' as const },
      ...(multiWarehouse ? [{ kind: 'wh' as const }] : []),
      ...(hasBatchButton ? [{ kind: 'batch' as const }] : []),
      { kind: 'qty' as const },
    ];
  }

  // Undo is a state of the cart, not a transient message: the offer lives in the
  // cart header until it is used, replaced by a newer removal, or invalidated by
  // a completed sale. A toast would vanish mid-recovery, and its viewport sits
  // bottom-right — exactly where Pay is.
  const [undoOffer, setUndoOffer] = useState<{ label: string; restore: () => void } | null>(null);
  const offerUndo = useCallback((label: string, restore: () => void) => {
    setUndoOffer({ label, restore });
  }, []);
  // A completed sale closes the window: restoring a line into a fresh cart would
  // silently corrupt the next order.
  useEffect(() => {
    if (orderComplete) setUndoOffer(null);
  }, [orderComplete]);

  // A line can disappear from one click on the X or from a single Esc, so every
  // removal leaves an undo behind and puts the line back at its original index
  // — the operator never has to re-enter a line to recover from a slip.
  const removeCartLine = useCallback((item: CartItem) => {
    const index = cart.findIndex(c => lineIdOf(c) === lineIdOf(item));
    if (index < 0) return;
    setCart(prev => prev.filter(i => !(i.id === item.id && (item.selected_unit?.id ? i.selected_unit?.id === item.selected_unit.id : true))));
    offerUndo(`Undo — restore ${item.name}`, () => setCart(prev => {
      const next = [...prev];
      next.splice(Math.min(index, next.length), 0, item);
      return next;
    }));
  }, [cart, offerUndo]);

  // Clearing is the one action that can destroy a whole order, and it sits on a
  // 12px text link in the header — so it is undoable rather than confirm-gated,
  // which keeps a deliberate clear fast.
  const clearCartWithUndo = useCallback(() => {
    if (cart.length === 0) return;
    const previous = cart;
    setCart([]);
    offerUndo(`Undo — restore ${previous.length} cleared line${previous.length === 1 ? '' : 's'}`, () => setCart(previous));
  }, [cart, offerUndo]);

  function updateCartPrice(id: string, unitId: string | undefined, newPrice: number) {
    setCart(prev => prev.map(i =>
      (i.id === id && i.selected_unit?.id === unitId) ? { ...i, unit_price: newPrice } : i
    ));
  }

  function updateCartItemDiscount(id: string, unitId: string | undefined, disc: number) {
    const clamped = Math.min(100, Math.max(0, disc));
    setCart(prev => prev.map(i =>
      (i.id === id && i.selected_unit?.id === unitId) ? { ...i, discount_percent: clamped } : i
    ));
  }

  // Qty typed into the line's input, including the native spinner's down arrow.
  // A 0 does NOT drop the line: the keyboard nudge (←) and this input must end
  // in the same state, and removal stays an explicit gesture (Esc / X). The
  // line just rests at 0 and openCheckout prunes it from the charge payload.
  function updateCartQuantity(id: string, unitId: string | undefined, newQty: number) {
    if (isNaN(newQty) || newQty < 0) return;
    setCart(prev => prev.map(i => {
      if (i.id !== id || (unitId && i.selected_unit?.id !== unitId)) return i;
      const allowDecimal = allowDecimalFor(i.allow_decimal, i.unit);
      const typedQty = clampSaleQty(newQty, allowDecimal);
      const baseQty = i.selected_unit ? convertToBaseUnit(typedQty, i.selected_unit) : typedQty;
      const extra = lineAvailableExtra(i);
      const maxBase = extra !== null ? i.base_quantity + extra : i.stock_available;
      if (baseQty > maxBase + 1e-9) {
        toast({ title: 'Stock limit', description: `Only ${fmtQty(maxBase)} ${i.selected_unit ? 'base units' : 'units'} available`, variant: 'destructive' });
        const maxQty = i.selected_unit ? maxBase / i.selected_unit.conversion_factor : maxBase;
        return { ...i, quantity: clampSaleQty(maxQty, allowDecimal), base_quantity: maxBase, allocOverride: null };
      }
      return { ...i, quantity: typedQty, base_quantity: baseQty, allocOverride: null };
    }));
  }

  // ---- Manual batch allocation (spec §9) --------------------------------
  // Eligible batches for a line with per-batch availability EXCLUDING this
  // line's own reservation: the engine is re-run on the rest of the cart and
  // each batch's remaining stock is reduced by what those lines hold.
  function editorBatchesFor(item: CartItem): EditorBatch[] {
    if (!allocBatches || !allocation) return [];
    const liKey = lineIdOf(item);
    const wh = resolveWarehouse({ warehouseId: item.warehouse_id }, defaultWarehouseId);
    const key = pairKey(item.id, wh);
    const eligible = allocation.batchesByPair.get(key) || [];
    const others = cart
      .filter(c => lineIdOf(c) !== liKey)
      .map(c => ({ lineId: lineIdOf(c), productId: c.id, warehouseId: c.warehouse_id, warehouseIds: lineWarehouseIds(c), baseQuantity: c.base_quantity, allocOverride: c.allocOverride }));
    const othersResult = allocateCartLines(others, allocBatches, strategy, defaultWarehouseId);
    const usedByOthers = new Map<string, number>();
    if (othersResult) {
      for (const la of othersResult.byLine.values()) {
        for (const a of la.allocations) usedByOthers.set(a.batch.id, (usedByOthers.get(a.batch.id) || 0) + a.qty);
      }
    }
    return eligible.map(b => ({ batch: b, available: Math.max(0, b.quantity_remaining - (usedByOthers.get(b.id) || 0)) }));
  }

  function autoAllocMapFor(item: CartItem): Record<string, number> {
    const out: Record<string, number> = {};
    const la = lineAllocation(item);
    if (la && !la.usedOverride) for (const a of la.allocations) out[a.batch.id] = a.qty;
    return out;
  }

  function saveAllocationOverride(item: CartItem, override: Record<string, number>) {
    setCart(prev => prev.map(c => (lineIdOf(c) === lineIdOf(item) ? { ...c, allocOverride: override } : c)));
    setEditingAllocLine(null);
    toast({ title: 'Batch allocation updated', description: 'Manual allocation saved for this line' });
  }

  // Warehouse selection for a line (single or multi). A new selection means
  // a new allocation: drop any manual override so automatic allocation
  // re-runs across the chosen warehouses.
  function setWarehousesForLine(liKey: string, warehouseIds: string[]) {
    setCart(prev => prev.map(c => {
      if (lineIdOf(c) !== liKey) return c;
      const whs = c.available_warehouses || [];
      const selected = whs.filter(w => warehouseIds.includes(w.warehouse_id));
      if (selected.length === 0) return c;
      const primary = selected.find(w => w.warehouse_id === warehouseIds[0]) || selected[0];
      const ids = selected.map(w => w.warehouse_id);
      // One warehouse selected: collapse back to the single-warehouse shape.
      const single = ids.length <= 1;
      return {
        ...c,
        warehouse_id: primary.warehouse_id,
        warehouse_ids: single ? undefined : ids,
        inventory_item_id: primary.inventory_item_id,
        stock_available: primary.stock,
        allocOverride: null,
      };
    }));
  }

  function reorderCart(fromIndex: number, toIndex: number) {
    setCart(prev => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }

  const lineTotals = cart.map(i => i.unit_price * i.quantity * (1 - (i.discount_percent || 0) / 100));
  const subtotal = lineTotals.reduce((s, t) => s + t, 0);
  const itemDiscountTotal = cart.reduce((s, i, idx) => s + (i.unit_price * i.quantity - lineTotals[idx]), 0);
  const cartDiscountAmount = (subtotal * discount) / 100;
  const discountAmount = cartDiscountAmount;
  const total = Math.max(0, subtotal - cartDiscountAmount - extraDiscount);
  const posVat = computeVat(total, vatSettings, applyVat);
  // Shipping is added AFTER VAT — the delivery charge is not part of the VAT base.
  const grandTotal = posVat.total + (shipping || 0);

  // The payment-application split for the charge about to be made. Pure and
  // cheap, so the checkout preview and the charge path share one computation —
  // the two can never disagree.
  const isRegisteredCustomer = !!selectedCustomer && selectedCustomer !== walkInCustomerId;
  const settlement = useMemo(
    () => buildPosSettlement({
      mode: collectMode,
      registered: isRegisteredCustomer,
      grandTotal,
      storeCredit: applyStoreCredit ? Math.min(storeCreditBalance, grandTotal) : 0,
      tendered: parseFloat(amountPaid) || 0,
      partialAmount: parseFloat(partialAmount) || 0,
      paymentTerm,
      dueCollectInput: dueCollectAmount,
      outstanding: customerOutstanding,
      advances: customerAdvances,
      advanceBalance,
    }),
    [
      collectMode, isRegisteredCustomer, grandTotal, applyStoreCredit, storeCreditBalance,
      amountPaid, partialAmount, paymentTerm, dueCollectAmount, customerOutstanding,
      customerAdvances, advanceBalance,
    ],
  );

  // Auto-hide the Order Complete panel after 30s — long enough to click
  // Print Receipt, short enough that the next sale isn't blocked for long.
  // Re-armed per order so a stale timer can never hide a newer panel.
  function armOrderCompleteHide() {
    if (orderCompleteTimerRef.current) clearTimeout(orderCompleteTimerRef.current);
    orderCompleteTimerRef.current = setTimeout(() => setOrderComplete(false), 30_000);
  }

  async function processOrder() {
    // One Charge click = one order. Extra clicks while a submission is in
    // flight (the gates below await fetches that hang offline, before the
    // disabled/`processing` feedback engages) must be swallowed, or each one
    // enqueues its own offline order with a fresh idempotency id.
    if (processingRef.current) return;
    processingRef.current = true;
    setProcessing(true);
    try {
      await doProcessOrder();
    } finally {
      processingRef.current = false;
      setProcessing(false);
    }
  }

  async function doProcessOrder() {
    if (cart.length === 0) { toast({ title: 'Cart is empty', variant: 'destructive' }); return; }
    if (!selectedCustomer) { toast({ title: 'Please select a customer first', variant: 'destructive' }); return; }

    // Oversell gate (warn-and-confirm): compare the cart against the FIFO batch
    // ledger. A shortfall is sellable ONLY after explicit confirmation — the
    // negative layer it creates is a conscious decision, not an accident. When
    // both the ledger AND the counter show no stock, treat it as a data error
    // (wrong SKU / 10x quantity typo) and block outright.
    // Stock is fetched fresh for exactly the cart's products (never a cached
    // full-catalog snapshot — that exceeded the 1000-row cap and false-warned).
    const gateStock = await fetchLedgerStockFor(
      Array.from(new Set(cart.map(i => i.id))),
      defaultWarehouseId
    );

    if (!shortfallConfirmedRef.current) {
      if (gateStock) {
        const shortfalls = computeShortfalls(
          cart.map(item => {
            const ids = lineWarehouseIds(item);
            const counters = item.available_warehouses || [];
            return {
              product_id: item.id,
              warehouse_id: item.warehouse_id,
              warehouse_ids: ids,
              base_quantity: item.base_quantity,
              name: item.name,
              sku: item.sku || '',
              cost_price: item.cost_price || 0,
              // Multi-warehouse lines are checked against the COMBINED
              // counter stock of their selected warehouses.
              stock_available: ids
                ? counters.filter(w => ids.includes(w.warehouse_id)).reduce((s, w) => s + w.stock, 0)
                : (item.stock_available ?? 0),
              track_inventory: item.track_inventory,
            };
          }),
          gateStock
        );

        if (shortfalls.length > 0) {
          const policy = await fetchOversellPolicy();
          const blocked = shortfalls.filter(s => s.bothEmpty);
          // With "Allow selling beyond stock" ON, a 0/ledger-empty line is a
          // deliberate oversell and gets the normal confirm dialog; treat it
          // as a suspected data error only when the setting is off or unknown.
          if (policy !== true && blocked.length > 0 && !gateStock.stale) {
            toast({
              title: 'Cannot sell — no stock record at all',
              description: `${blocked.map(s => s.name).join(', ')}: 0 in the batch ledger and 0 on hand. Check the product/SKU or receive stock first.`,
              variant: 'destructive',
            });
            return;
          }
          // With a stale (offline) snapshot, "no record" may just mean "never
          // cached on this device" — downgrade the hard block to a warning
          // that requires the same explicit confirmation as any shortfall.
          // When "Allow selling beyond stock" is OFF, the DB rejects any
          // shortfall, so the dialog opens in hard-block mode instead.
          setOversellBlocked(policy === false);
          setPendingShortfalls(shortfalls);
          setShortfallConfirmOpen(true);
          return;
        }
      } else {
        // Advisory gate: a failed lookup must not block the shop — the DB
        // permits the sale either way. Surface it and continue.
        toast({
          title: 'Ledger check unavailable',
          description: 'Batch-ledger stock could not be verified; continuing without the oversell check.',
        });
      }
    }

    // Payment-application validation. The two account modes need a customer
    // account to move money on, and each is meaningless without its money
    // source — block early instead of writing a sale the cashier did not mean.
    if (collectMode === 'dues_first' && isRegisteredCustomer && settlement.tendered <= 0) {
      toast({
        title: 'Enter the cash received',
        description: 'Previous-dues-first clears the oldest unpaid invoices from the cash handed over.',
        variant: 'destructive',
      });
      return;
    }
    if (collectMode === 'advance_first' && isRegisteredCustomer
      && settlement.advanceApplied <= 0 && settlement.tendered <= 0) {
      toast({
        title: 'Nothing to collect',
        description: 'This customer has no advance balance left — enter the cash received or switch to Cash.',
        variant: 'destructive',
      });
      return;
    }
    // Partial terms still need a sane amount (the mode-independent guard that
    // used to live next to the term switch inside the try block).
    if (collectMode === 'cash' && paymentTerm === 'partial') {
      const partialNum = parseFloat(partialAmount) || 0;
      if (partialNum <= 0) {
        toast({ title: 'Invalid amount', description: 'Please enter a partial payment amount', variant: 'destructive' });
        return;
      }
      if (partialNum >= grandTotal) {
        toast({ title: 'Invalid amount', description: 'Partial payment must be less than total. Use Full Payment.', variant: 'destructive' });
        return;
      }
    }

    // Credit-limit gate (warn-and-confirm): the receivable this sale creates is
    // the part of THIS invoice the customer still owes after every source of
    // money applied to it — cash, store credit and advance. Money that cleared
    // OLDER invoices does not reduce it. The customer is fetched fresh at gate
    // time; a failed lookup fails open.
    if (!creditConfirmedRef.current) {
      const credit = await checkCreditLimit(
        selectedCustomer,
        newReceivableFor(
          grandTotal,
          settlement.cashToBill + settlement.advanceApplied,
          settlement.storeCredit
        )
      );
      if (credit) {
        setPendingCreditCheck(credit);
        setCreditConfirmOpen(true);
        return;
      }
    }

    setProcessing(true);

    try {
      // Offline checkout: the gates above already ran against cached
      // snapshots (advisory, same warn-and-confirm policy). Queue the exact
      // same payload the online path would have written; the server applies
      // it atomically via sync_apply when connectivity returns.
      if (!networkMonitor.getState().online) {
        const queued = await queueOfflineOrder(settlement);
        if (queued) {
          setProcessing(false);
          armOrderCompleteHide();
        }
        return;
      }

      const { data: posNum } = await supabase.rpc('generate_pos_number');
      const invoiceNumber = posNum || `POS-${Date.now().toString().slice(-8)}`;
      setLastInvoiceNumber(invoiceNumber);

      const customerId = selectedCustomer;
      const creditToApply = settlement.storeCredit;

      // The payment-application split decides everything this charge writes:
      // the invoice's paid amount/status, the cash row, the dues sweep and the
      // advance application. See buildPosSettlement.
      const amountPaid = settlement.invoiceAmountPaid;
      const invoiceStatus = settlement.invoiceStatus;
      const cashToPay = settlement.cashToBill;
      // What actually landed. A failed dues sweep or a wallet that came up
      // short shrinks these, and the receipt must show money that really moved
      // rather than what we intended to move.
      let duesClearedActual = settlement.duesCleared;
      let advanceAppliedActual = 0;

      const { data: invoice, error: invError } = await supabase
        .from('invoices')
        .insert({
          invoice_number: invoiceNumber,
          customer_id: customerId,
          invoice_date: invoiceDate,
          subtotal: subtotal,
          discount_amount: cartDiscountAmount,
          cart_discount_percent: discount,
          extra_discount: extraDiscount,
          tax_amount: posVat.taxAmount,
          shipping_cost: shipping || 0,
          total_amount: grandTotal,
          amount_paid: amountPaid,
          status: invoiceStatus,
          is_pos: true,
          reference: reference || null,
        })
        .select()
        .single();

      if (invError) throw invError;
      if (!invoice) throw new Error('Invoice not created');

      // One cart line can split into several invoice items (multi-warehouse
      // allocation) — each item carries its own warehouse so the per-item
      // triggers (deduct, FIFO consumption, COGS) land on the right pair.
      const invoiceItems = cart.flatMap(item =>
        splitLineForSubmit(item).map(sp => ({
          invoice_id: invoice.id,
          product_id: item.id,
          quantity: sp.quantity,
          unit_price: item.unit_price,
          cost_price: item.cost_price || 0,
          discount_percent: item.discount_percent || 0,
          tax_rate: 0,
          subtotal: sp.subtotal,
          unit_name: item.selected_unit?.unit_name,
          unit_conversion_factor: item.selected_unit?.conversion_factor,
          base_quantity: sp.base_quantity,
          warehouse_id: sp.warehouse_id,
          description: gateStock
            ? shortfallDescription(
                { product_id: item.id, warehouse_id: sp.warehouse_id, base_quantity: sp.base_quantity },
                gateStock,
                'POS'
              )
            : null,
        }))
      );

      const { error: itemsError } = await supabase.from('invoice_items').insert(invoiceItems);
      if (itemsError) {
        // The invoice shell above was already committed by its own request; if
        // the item insert fails and we just throw, the shell survives as a
        // 0-item husk (with its auto-posted JE) — every retry adds another.
        // Cancel it through the standard reversal path before surfacing the error.
        try {
          await supabase.rpc('cancel_invoice', {
            p_invoice_id: invoice.id,
            p_reason: `Auto-cancel — POS item insert failed: ${itemsError.message}`.slice(0, 300),
            p_cancelled_by: 'pos-checkout-cleanup',
          });
        } catch {
          // Best-effort cleanup; the thrown error below still surfaces the cause.
        }
        throw itemsError;
      }

      // Record cost price history snapshot for each item at time of sale —
      // split per warehouse the same way the invoice items are.
      const costHistoryRecords = cart.flatMap(item => {
        const unitName = item.selected_unit?.unit_name || 'pcs';
        const costPerUnit = item.cost_price || 0;
        return splitLineForSubmit(item).map(sp => ({
          product_id: item.id,
          product_name: item.name,
          product_sku: item.sku || '',
          invoice_id: invoice.id,
          unit: unitName,
          quantity: sp.quantity,
          unit_price: item.unit_price,
          cost_price_per_qty: costPerUnit,
          cost_price_for_added_qty: costPerUnit * sp.quantity,
          total_cost_price_single: costPerUnit,
          total_cost_price_added: costPerUnit * sp.quantity,
        }));
      });
      if (costHistoryRecords.length > 0) {
        await supabase.from('cost_price_history').insert(costHistoryRecords);
      }

      // Stock deduction is handled by the DB trigger on invoice_items INSERT

      // Record payment: if store credit is applied, record the cash/card portion separately
      if (settlement.mode === 'cash' && paymentTerm === 'credit') {
        // On credit — no payment to record. The account modes always record the
        // money they collected, so a stale "On Credit" term must not skip the
        // store-credit redemption this bill is being paid with.
      } else if (creditToApply > 0) {
        // Redeem store credit — same expiry filter as the displayed balance,
        // so what can be spent is exactly what was offered
        const { data: activeCredits } = await supabase
          .from('customer_store_credits')
          .select('id, balance')
          .eq('customer_id', customerId)
          .eq('status', 'active')
          .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
          .order('created_at', { ascending: true });

        let remainingToRedeem = creditToApply;
        for (const credit of (activeCredits || [])) {
          if (remainingToRedeem <= 0) break;
          const redeemAmount = Math.min(Number(credit.balance), remainingToRedeem);
          await supabase.from('store_credit_redemptions').insert({
            store_credit_id: credit.id,
            customer_id: customerId,
            invoice_id: invoice.id,
            amount: redeemAmount,
            notes: `Redeemed for ${invoiceNumber}`,
          });
          remainingToRedeem -= redeemAmount;
        }

        // Record store credit as a payment
        const { data: scPayNum } = await supabase.rpc('generate_payment_number');
        const { error: creditPayError } = await supabase.from('payments').insert({
          payment_number: `PAY-SC-${(scPayNum || '').replace('PAY-', '')}`,
          payment_type: 'received',
          reference_type: 'invoice',
          reference_id: invoice.id,
          customer_id: customerId,
          amount: creditToApply,
          payment_method: 'store_credit',
          payment_date: invoiceDate,
          notes: `Store credit redeemed for ${invoiceNumber}`,
          payment_for: 'paid_invoice_pay',
        });
        if (creditPayError) console.error('Store credit payment record error:', creditPayError.message);
      }

      // Record cash/card payment for the remaining amount
      if (cashToPay > 0) {
        const { data: posPayNum } = await supabase.rpc('generate_payment_number');
        const { error: payError } = await supabase.from('payments').insert({
          payment_number: posPayNum || `PAY-${Date.now().toString().slice(-6)}`,
          payment_type: 'received',
          reference_type: 'invoice',
          reference_id: invoice.id,
          customer_id: customerId,
          amount: cashToPay,
          payment_method: paymentMethod,
          payment_date: invoiceDate,
          notes: creditToApply > 0 ? `POS sale (partial store credit: ${formatCurrency(creditToApply)})` : 'POS sale',
          payment_for: 'paid_invoice_pay',
        });
        if (payError) console.error('Payment record error:', payError.message);
      }

      // Previous-due collection: the settlement's oldest-first split of the
      // cash goes through the shared RPC (each payment row is linked back to
      // this sale so cancel_invoice reverses the collection).
      if (settlement.duesAlloc.length > 0) {
        const allocations = settlement.duesAlloc.map(a => ({
          invoice_id: a.invoice_id,
          amount: a.amount,
          bad_debt_amount: 0,
        }));
        const { error: dueErr } = await supabase.rpc('collect_customer_payment', {
          p_customer_id: customerId,
          p_payment_date: invoiceDate,
          p_payment_method: paymentMethod,
          p_reference_number: null,
          p_notes: settlement.mode === 'dues_first'
            ? `Old dues cleared first with POS sale ${invoiceNumber}`
            : `Collected with POS sale ${invoiceNumber}`,
          p_allocations: allocations,
          p_overpayment: 0,
          p_route_overpayment: false,
          p_collected_with_invoice_id: invoice.id,
        });
        if (dueErr) {
          // The sale itself already succeeded — keep it, but warn loudly so
          // the due can be re-collected from the Collect Payment screen.
          console.error('Due collection error:', dueErr.message);
          toast({
            title: 'Due collection failed',
            description: `Sale completed, but ${formatCurrency(settlement.duesCleared)} previous due was not recorded: ${dueErr.message}`,
            variant: 'destructive',
          });
          duesClearedActual = 0;
        }
      }

      // Advance-balance-first: the customer's wallets settle this invoice
      // through collect_customer_advance (application rows, wallet balances,
      // Dr 2300 / Cr 1100, invoice amount_paid + status). The invoice was
      // written WITHOUT the advance, so a wallet that comes up short leaves a
      // correctly-unpaid invoice instead of phantom money. The RPC is capped at
      // the live balance and reports the shortfall rather than failing.
      if (settlement.advanceApplied > 0) {
        const { data: advRes, error: advErr } = await supabase.rpc('collect_customer_advance', {
          p_customer_id: customerId,
          p_invoice_id: invoice.id,
          p_amount: settlement.advanceApplied,
          p_advance_ids: settlement.advanceAlloc.map(a => a.advance_id),
          p_payment_date: invoiceDate,
          p_notes: `Advance applied with POS sale ${invoiceNumber}`,
        });
        if (advErr) {
          console.error('Advance application error:', advErr.message);
          toast({
            title: 'Advance not applied',
            description: `Sale completed, but ${formatCurrency(settlement.advanceApplied)} of advance balance was not applied: ${advErr.message}. The invoice keeps its balance — apply it from the Advances screen.`,
            variant: 'destructive',
          });
        } else {
          advanceAppliedActual = round2(Number(advRes?.applied_amount) || 0);
          if (advanceAppliedActual + 0.001 < settlement.advanceApplied) {
            toast({
              title: 'Advance balance changed',
              description: `Only ${formatCurrency(advanceAppliedActual)} of the ${formatCurrency(settlement.advanceApplied)} advance was still available. The rest stays due on this invoice.`,
            });
          }
        }
      }

      // Receipt snapshot — taken while the cart is still populated.
      setLastReceipt({
        number: invoiceNumber,
        offline: false,
        date: invoiceDate,
        status: settlement.mode === 'advance_first' && advanceAppliedActual > 0
          ? settlement.finalStatus
          : invoiceStatus,
        customer: customers.find(c => c.id === customerId) || null,
        items: cart.map(item => ({
          product_name: item.name,
          product_sku: item.sku,
          quantity: item.quantity,
          unit_price: item.unit_price,
          discount_percent: item.discount_percent || 0,
          subtotal: item.quantity * item.unit_price * (1 - (item.discount_percent || 0) / 100),
          unit_name: item.selected_unit?.unit_name ?? undefined,
          warranty_months: item.warranty_months,
        })),
        subtotal,
        cartDiscount: cartDiscountAmount,
        cartDiscountPercent: discount,
        extraDiscount,
        taxAmount: posVat.taxAmount,
        shipping,
        total: grandTotal,
        amountPaid,
        cashPaid: cashToPay,
        storeCredit: creditToApply,
        dueCollected: duesClearedActual,
        previousDue: settlement.previousDueBefore,
        advanceApplied: advanceAppliedActual,
        paidTotal: round2(settlement.invoiceAmountPaid + advanceAppliedActual),
        paymentMethod,
        reference,
      });

      setCart([]);
      setDiscount(0);
      setExtraDiscount(0);
      setShipping(0);
      setSelectedCustomer(walkInCustomerId);
      setStoreCreditBalance(0);
      setApplyStoreCredit(false);
      setDueCollectInput('');
      setCustomerOutstanding([]);
      setCustomerAdvances([]);
      setCollectMode('cash');
      setPaymentTerm('full');
      setPartialAmount('');
      setShowCheckout(false);
      setAmountPaid('');
      setCartTab('items');
      setInvoiceDate(new Date().toISOString().split('T')[0]);
      setReference('');
      shortfallConfirmedRef.current = false;
      creditConfirmedRef.current = false;
      setOrderComplete(true);
      toast({ title: 'Success', description: `Order ${invoiceNumber} completed successfully` });
      // The sale drew stock server-side — patch the local snapshot instead of
      // re-downloading the whole catalog.
      await applySaleToSnapshot(cart);
      // The DB also recomputed this customer's outstanding_balance (the
      // invoice, plus any receivable payment collected alongside it). Converge
      // the local copy FIRST, then drop the customer aggregate and rebuild it:
      // dropping before the pull lands would rebuild it from the pre-sale
      // replica, and the 60 s TTL would freeze that figure again.
      void awaitPendingWrites().then(() => {
        void cacheDelete(CACHE_KEYS.customers);
        void loadCustomers();
      });
      loadProducts(search);
    } catch (error: any) {
      console.error('POS error:', error);
      shortfallConfirmedRef.current = false;
      creditConfirmedRef.current = false;
      toast({ title: 'Error', description: error.message || 'Failed to process order', variant: 'destructive' });
    }

    setProcessing(false);
    armOrderCompleteHide();
  }

  // Offline checkout: mirror processOrder's number computation and payload
  // construction, queue it encrypted in the local outbox, and apply the same
  // optimistic stock effects the server triggers would apply. The server-side
  // sync_invoice_create handler replays this atomically (invoice → items →
  // cost history → store credit → payment, with FIFO/journal triggers firing
  // exactly as in the online path).
  async function queueOfflineOrder(settle: PosSettlement): Promise<boolean> {
    const customerId = selectedCustomer;
    // Everything this queued sale carries comes from the same settlement the
    // online path writes — including the advance applications replayed later by
    // sync_advance_apply (application row, wallet balance, Dr 2300 / Cr 1100,
    // invoice state), so offline and online leave identical books.
    const creditToApply = settle.storeCredit;
    const amountPaid = settle.invoiceAmountPaid;
    const invoiceStatus = settle.invoiceStatus;
    const cashToPay = settle.cashToBill;

    const tempNumber = `OFF-${Date.now().toString().slice(-8)}`;
    const customerName = customers.find(c => c.id === customerId)?.name || 'customer';

    // Split per warehouse exactly like the online path (multi-warehouse
    // allocation) — sync_invoice_create replays the same item shape and the
    // per-item triggers fire at replay.
    const items = cart.flatMap(item =>
      splitLineForSubmit(item).map(sp => ({
        product_id: item.id,
        quantity: sp.quantity,
        unit_price: item.unit_price,
        cost_price: item.cost_price || 0,
        discount_percent: item.discount_percent || 0,
        tax_rate: 0,
        subtotal: sp.subtotal,
        unit_name: item.selected_unit?.unit_name ?? null,
        unit_conversion_factor: item.selected_unit?.conversion_factor ?? null,
        base_quantity: sp.base_quantity,
        warehouse_id: sp.warehouse_id,
        description: null,
      }))
    );

    const cost_history = cart.flatMap(item => {
      const unitName = item.selected_unit?.unit_name || 'pcs';
      const costPerUnit = item.cost_price || 0;
      return splitLineForSubmit(item).map(sp => ({
        product_id: item.id,
        product_name: item.name,
        product_sku: item.sku || '',
        unit: unitName,
        quantity: sp.quantity,
        unit_price: item.unit_price,
        cost_price_per_qty: costPerUnit,
        cost_price_for_added_qty: costPerUnit * sp.quantity,
        total_cost_price_single: costPerUnit,
        total_cost_price_added: costPerUnit * sp.quantity,
      }));
    });

    // Client-generated invoice id: the server honors it (sync_invoice_create),
    // so queued due-collection payments can link back to THIS sale before it
    // has a real POS- number.
    const invoiceId = crypto.randomUUID();

    try {
      await enqueueOp('invoice.create', {
        id: invoiceId,
        idempotency_key: chargeIntentIdRef.current,
        temp_number: tempNumber,
        is_pos: true,
        customer_id: customerId,
        invoice_date: invoiceDate,
        subtotal,
        discount_amount: cartDiscountAmount,
        cart_discount_percent: discount,
        extra_discount: extraDiscount,
        tax_amount: posVat.taxAmount,
        shipping_cost: shipping || 0,
        total_amount: grandTotal,
        amount_paid: amountPaid,
        status: invoiceStatus,
        reference: reference || null,
        items,
        cost_history,
        store_credit_amount: creditToApply,
        cash_payment: { amount: cashToPay, method: paymentMethod },
      }, `POS sale ${formatCurrency(grandTotal)} — ${customerName}`);
    } catch (err: any) {
      toast({ title: 'Could not queue order', description: err?.message || 'Offline storage error', variant: 'destructive' });
      setProcessing(false);
      return false;
    }

    // Previous-due collection: one payment.create op per oldest-first
    // allocation — the same shape CollectPaymentModal queues offline. Each op
    // links back to this sale via collected_with_invoice_id; sync applies
    // invoice.create first (strict queue order), so the link resolves at
    // replay and a later cancel_invoice reverses the collection automatically.
    // sync_payment_create re-validates the LIVE balance at replay, so a due
    // settled by another device in the meantime parks as a Sync Center
    // conflict instead of a silent overpay.
    let queuedDue = 0;
    // One collection_id across all due ops so the statement shows a single
    // combined Payment row when they replay.
    const duesCollectionId = crypto.randomUUID();
    for (const row of settle.duesAlloc) {
      try {
        await enqueueOp('payment.create', {
          idempotency_key: crypto.randomUUID(),
          invoice_id: row.invoice_id,
          customer_id: customerId,
          amount: row.amount,
          bad_debt_amount: 0,
          payment_method: paymentMethod,
          payment_date: invoiceDate,
          reference_number: null,
          notes: settle.mode === 'dues_first'
            ? `Old dues cleared first with POS sale ${tempNumber}`
            : `Collected with POS sale ${tempNumber}`,
          payment_for: 'outstanding_invoice_pay',
          collected_with_invoice_id: invoiceId,
          collection_id: duesCollectionId,
        }, `Due collection ${formatCurrency(row.amount)} — ${row.invoice_number}`);
      } catch (err: any) {
        // The sale itself is already queued — keep it; dues queued so far
        // stay queued. The rest can be collected later from the Collect
        // Payment screen.
        toast({ title: 'Due collection not fully queued', description: err?.message || 'Offline storage error', variant: 'destructive' });
        break;
      }
      queuedDue = round2(queuedDue + row.amount);
    }

    // Advance-balance-first: one advance.apply op per wallet, queued AFTER the
    // invoice op (strict queue order) so sync_advance_apply finds the invoice by
    // the client-generated id and re-validates the LIVE wallet balance at
    // replay. A wallet spent by another device in the meantime parks as a Sync
    // Center conflict instead of silently over-spending it.
    let queuedAdvance = 0;
    for (const a of settle.advanceAlloc) {
      try {
        await enqueueOp('advance.apply', {
          idempotency_key: crypto.randomUUID(),
          advance_id: a.advance_id,
          customer_id: customerId,
          invoice_id: invoiceId,
          amount: a.amount,
        }, `Advance applied ${formatCurrency(a.amount)} — ${a.advance_number}`);
      } catch (err: any) {
        toast({ title: 'Advance not fully queued', description: err?.message || 'Offline storage error', variant: 'destructive' });
        break;
      }
      queuedAdvance = round2(queuedAdvance + a.amount);
    }

    // Optimistic local effects so this session stays consistent: decrement
    // the cached product snapshot (counter stock) and the oversell-gate
    // ledger snapshot by exactly what was sold.
    await applySaleToSnapshot(cart);

    // Receipt snapshot — taken while the cart is still populated. The number
    // is the device's temporary reference; the printout carries the
    // provisional banner until sync assigns the real POS- number.
    setLastReceipt({
      number: tempNumber,
      offline: true,
      date: invoiceDate,
      status: settle.mode === 'advance_first' && queuedAdvance > 0
        ? settle.finalStatus
        : invoiceStatus,
      customer: customers.find(c => c.id === customerId) || null,
      items: cart.map(item => ({
        product_name: item.name,
        product_sku: item.sku,
        quantity: item.quantity,
        unit_price: item.unit_price,
        discount_percent: item.discount_percent || 0,
          subtotal: item.quantity * item.unit_price * (1 - (item.discount_percent || 0) / 100),
          unit_name: item.selected_unit?.unit_name ?? undefined,
          warranty_months: item.warranty_months,
        })),
        subtotal,
        cartDiscount: cartDiscountAmount,
        cartDiscountPercent: discount,
        extraDiscount,
        taxAmount: posVat.taxAmount,
        shipping,
        total: grandTotal,
        amountPaid,
      cashPaid: cashToPay,
      storeCredit: creditToApply,
      dueCollected: queuedDue,
      previousDue: queuedDue > 0 ? settle.previousDueBefore : 0,
      advanceApplied: queuedAdvance,
      paidTotal: round2(settle.invoiceAmountPaid + queuedAdvance),
      paymentMethod,
      reference,
    });

    // Same cart reset as the online path.
    setCart([]);
    setDiscount(0);
    setExtraDiscount(0);
    setShipping(0);
    setSelectedCustomer(walkInCustomerId);
    setStoreCreditBalance(0);
    setApplyStoreCredit(false);
    setDueCollectInput('');
    setCustomerOutstanding([]);
    setCustomerAdvances([]);
    setCollectMode('cash');
    setPaymentTerm('full');
    setPartialAmount('');
    setShowCheckout(false);
    setAmountPaid('');
    setCartTab('items');
    setInvoiceDate(new Date().toISOString().split('T')[0]);
    setReference('');
    shortfallConfirmedRef.current = false;
    creditConfirmedRef.current = false;
    setOrderComplete(true);
    setLastInvoiceNumber(tempNumber);
    toast({
      title: 'Order queued offline',
      description: `${tempNumber} (${formatCurrency(grandTotal)}) saved on this device — it will sync automatically when you're back online.${queuedDue > 0 ? ` Includes ${formatCurrency(queuedDue)} previous-due collection.` : ''}`,
    });
    loadProducts(search);
    return true;
  }

  const paymentMethodIcons: Record<string, any> = {
    cash: Banknote,
    bank_transfer: CreditCard,
    card: CreditCard,
    mobile_banking: Smartphone,
    cheque: CreditCard,
    other: Banknote,
  };
  const paymentMethodColors: Record<string, string> = {
    cash: 'text-green-600 bg-green-50 border-green-200',
    bank_transfer: 'text-blue-600 bg-blue-50 border-blue-200',
    card: 'text-indigo-600 bg-indigo-50 border-indigo-200',
    mobile_banking: 'text-pink-600 bg-pink-50 border-pink-200',
    cheque: 'text-amber-600 bg-amber-50 border-amber-200',
    other: 'text-gray-600 bg-gray-50 border-gray-200',
  };
  const displayMethods = paymentMethods.length > 0 ? paymentMethods : [
    { code: 'cash', name: 'Cash' },
    { code: 'card', name: 'Card' },
    { code: 'mobile_banking', name: 'Mobile Banking' },
  ];

  const [showMobileCart, setShowMobileCart] = useState(false);
  // Keyboard cart navigation: which line the ↑/↓ cursor sits on (null = none),
  // and which of that line's controls (Price/Disc/WH/Batch/Qty) the
  // Shift+←/→ field cursor points at (null = line level).
  const [activeCartLine, setActiveCartLine] = useState<number | null>(null);
  const [activeCartField, setActiveCartField] = useState<number | null>(null);
  const [cartMaximized, setCartMaximized] = useState(false);
  const [cartTab, setCartTab] = useState<'items' | 'cost'>('items');
  const [showCheckout, setShowCheckout] = useState(false);
  // Each checkout session is a fresh charge intent — a new idempotency key
  // per modal open. Must sit after the showCheckout declaration: the
  // dependency below evaluates during render.
  const posRootRef = useRef<HTMLDivElement>(null);
  const cartPanelRef = useRef<HTMLDivElement>(null);
  const cartListRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [cartHeightOverride, setCartHeightOverride] = useState<number | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Background scroll lock for the mobile cart sheet. `showMobileCart` is only
  // ever set from the lg:hidden cart bar, so this is a mobile-only state.
  // Without the lock a touch drag on the dimmed backdrop scroll-chains to the
  // page behind the sheet: the sheet stays put (it is viewport-anchored now)
  // but the product grid underneath slides away, so closing the cart drops the
  // cashier somewhere else in the catalogue.
  useEffect(() => {
    if (!showMobileCart) return;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflow; };
  }, [showMobileCart]);
  // Pinned cart footer: while the auto-grown cart's footer is scrolled out of
  // view, a fixed clone floats at the viewport bottom. The page scrolls in the
  // window (main grows with the page and never scrolls internally), so CSS
  // sticky cannot reach the viewport from inside the cart panel.
  const [footerPinned, setFooterPinned] = useState(false);
  const [footerBarRect, setFooterBarRect] = useState({ h: 0, left: 0, width: 0 });
  const cartFooterRef = useRef<HTMLDivElement>(null);
  // Sale details is a disclosure panel that rises from the footer. It is
  // deliberately *not* an inline expansion: growing the footer inside the
  // panel pushed the fields below the fold (the panel grew past the viewport
  // and the page had to scroll), shrank the item list on mobile, and moved the
  // Pay button away from under the cursor. As an overlay the cart geometry —
  // list height, footer position, primary action — never changes.
  const [showSaleDetails, setShowSaleDetails] = useState(false);
  const saleDetailsId = `${useId()}-sale-details`;
  const closeSaleDetails = () => {
    setShowSaleDetails(false);
    requestAnimationFrame(() => {
      const btn = Array.from(document.querySelectorAll<HTMLElement>('[data-sale-details-toggle]'))
        .find(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
      btn?.focus();
    });
  };
  const toggleSaleDetails = () => {
    if (showSaleDetails) { closeSaleDetails(); return; }
    setShowSaleDetails(true);
    // The footer is rendered twice (in flow + pinned clone); focus the copy
    // that is actually painted.
    requestAnimationFrame(() => {
      const panel = Array.from(document.querySelectorAll<HTMLElement>('[data-sale-details-panel]'))
        .find(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
      panel?.focus();
    });
  };
  // Dismiss the panel on an outside press, like any popover. Matches the panel
  // and the toggle so both footer copies (in flow + pinned) behave the same.
  useEffect(() => {
    if (!showSaleDetails) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t?.closest('[data-sale-details-panel], [data-sale-details-toggle]')) return;
      setShowSaleDetails(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showSaleDetails]);
  // Auto-grow is opt-in: the cart keeps its normal height and scrolls inside
  // itself until the cashier asks it to grow. The storage key is versioned
  // because the previous key defaulted to ON — every tab that had already
  // written a value would otherwise keep growing after this change.
  const [cartAutoGrow, setCartAutoGrow] = useState(() => {
    if (typeof window === 'undefined') return false;
    return sessionStorage.getItem('posCartAutoGrow2') === 'on';
  });
  // The cart list is a bounded pane, so it scrolls — and it has to say so.
  // macOS overlay scrollbars stay invisible until the user scrolls, so the
  // list draws its own edge fades: one per edge, each shown only while there
  // is content hidden past it. Both are pointer-events-none overlays, so they
  // never sit between the pointer and a line's controls.
  const [cartScrollEdges, setCartScrollEdges] = useState({ top: false, bottom: false });
  const syncCartScrollEdges = useCallback(() => {
    const el = cartListRef.current;
    if (!el) return;
    const top = el.scrollTop > 4;
    const bottom = el.scrollHeight - el.clientHeight - el.scrollTop > 4;
    setCartScrollEdges(prev => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
  }, []);
  const prevCartCount = useRef(0);
  useEffect(() => {
    if (showCheckout) chargeIntentIdRef.current = crypto.randomUUID();
  }, [showCheckout]);
  useEffect(() => {
    const el = posRootRef.current;
    const main = el?.parentElement;
    if (!el || !main) return;
    let raf = 0;
    const apply = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!window.matchMedia('(min-width: 1024px)').matches) {
          el.style.removeProperty('--pos-h');
          return;
        }
        const padTop = parseFloat(getComputedStyle(main).paddingTop) || 0;
        const padBottom = parseFloat(getComputedStyle(main).paddingBottom) || 0;
        const available = window.innerHeight - main.offsetTop - padTop - padBottom;
        const h = Math.max(available, 320, cartHeightOverride ?? 0);
        el.style.setProperty('--pos-h', `${h}px`);
      });
    };
    apply();
    window.addEventListener('resize', apply);
    const ro = new ResizeObserver(apply);
    ro.observe(main);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', apply);
      ro.disconnect();
      el.style.removeProperty('--pos-h');
    };
  }, [cartHeightOverride]);
  // New lines are prepended, so the list returns to the top to reveal them.
  useEffect(() => {
    if (cart.length > prevCartCount.current) {
      const el = cartListRef.current;
      if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
    }
    prevCartCount.current = cart.length;
  }, [cart.length]);
  // Edge fades are geometry, not render state: re-measure when the content
  // changes (lines added, a batch row opening, the tab switching) and when the
  // pane resizes (viewport, auto-grow, maximize).
  useEffect(() => {
    const el = cartListRef.current;
    if (!el) return;
    syncCartScrollEdges();
    const ro = new ResizeObserver(syncCartScrollEdges);
    ro.observe(el);
    const mo = new MutationObserver(syncCartScrollEdges);
    mo.observe(el, { childList: true, subtree: true });
    window.addEventListener('resize', syncCartScrollEdges);
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', syncCartScrollEdges);
    };
  }, [syncCartScrollEdges]);
  // Auto-grow (opt-in, off by default): when enabled, from 3 items the cart
  // extends downward (the page grows with it) so every item stays visible;
  // past 50 items growth stops and the list scrolls internally. The header
  // button reads "Auto-grow" when off and "Reset size" when on.
  // Sale details is an overlay and never participates in this calculation.
  useEffect(() => {
    if (cart.length > 50) return; // freeze at the 50-item height
    const itemGrow = cartAutoGrow && cart.length >= 3;
    if (!itemGrow) {
      setCartHeightOverride(null);
      return;
    }
    let raf = requestAnimationFrame(() => {
      const root = posRootRef.current;
      const panel = cartPanelRef.current;
      const list = cartListRef.current;
      if (!root || !panel || !list) return;
      // The cart already fills the column by default; only grow the page when
      // the content is taller than that column.
      const main = root.parentElement;
      const padTop = main ? parseFloat(getComputedStyle(main).paddingTop) || 0 : 0;
      const padBottom = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0;
      const avail = main ? window.innerHeight - main.offsetTop - padTop - padBottom : window.innerHeight;
      // Natural content height of the list. `list.scrollHeight` cannot be
      // used when the panel is taller than its content (e.g. right after
      // closing the footer): a stretched list reports its stretched height,
      // pinning the panel at the expanded size and leaving a large gap.
      // Span from the first real item to the last instead (scroll-safe; the
      // sticky fade overlay is excluded).
      const cs = getComputedStyle(list);
      const listPad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const items = Array.from(list.children).filter((c) => {
        const p = getComputedStyle(c).position;
        return p !== 'sticky' && p !== 'absolute';
      }) as HTMLElement[];
      const natural = items.length
        ? listPad + (items[items.length - 1].getBoundingClientRect().bottom - items[0].getBoundingClientRect().top)
        : list.scrollHeight;
      const desired = panel.offsetHeight - list.offsetHeight + Math.ceil(natural);
      setCartHeightOverride(desired > avail ? desired : null);
    });
    return () => cancelAnimationFrame(raf);
  }, [cart.length, cartAutoGrow, cartMaximized]);
  // Geometry for the pinned footer clone: panel left/width and footer height.
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const panel = cartPanelRef.current;
        const footer = cartFooterRef.current;
        if (!panel || !footer) return;
        const pr = panel.getBoundingClientRect();
        setFooterBarRect({ h: footer.offsetHeight, left: pr.left, width: pr.width });
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (cartFooterRef.current) ro.observe(cartFooterRef.current);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); cancelAnimationFrame(raf); };
  }, [cartHeightOverride, cartMaximized, cart.length]);
  // Pin decision: the in-flow footer keeps its space (only visually hidden
  // while pinned), so its rect is always the true flow position.
  useEffect(() => {
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const active = window.matchMedia('(min-width: 1024px)').matches
          && cartHeightOverride != null
          && !cartMaximized
          && !orderComplete;
        setFooterPinned(active && !!cartFooterRef.current
          && cartFooterRef.current.getBoundingClientRect().bottom > window.innerHeight + 1);
      });
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => { window.removeEventListener('scroll', update); window.removeEventListener('resize', update); cancelAnimationFrame(raf); };
  }, [cartHeightOverride, cartMaximized, cart.length, orderComplete]);
  useEffect(() => {
    sessionStorage.setItem('posCartAutoGrow2', cartAutoGrow ? 'on' : 'off');
  }, [cartAutoGrow]);
  // Keyboard shortcuts (cheat-sheet on "?"): "/" focus search, Shift+N new
  // sale, Shift+P / Ctrl+Enter checkout, Shift+L footer toggle, Esc steps
  // back — and on a selected cart line, Esc removes it (Esc is the only key
  // that removes a line: Delete/Backspace stay free for editing text inside
  // the qty, price and discount inputs on macOS). Cart lines: ↑/↓ move
  // the line cursor, Shift+←/→ cycle the line's controls, Enter selects one,
  // ←/→ nudge its qty (may rest at 0 without dropping the line). Checkout
  // modal: arrows choose Collect From / Term / Method, Enter = Next then
  // Charge. While typing in an input only Esc and Ctrl+Enter work, so
  // letters and "/" never eat typed text.
  useEffect(() => {
    const isEditable = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showShortcuts) { setShowShortcuts(false); return; }
        if (showCheckout) { setShowCheckout(false); return; }
        // A line's warehouse/batch modal sits above the cart, so Esc closes it
        // instead of clearing the field ring or removing the line beneath it.
        if (pickingWarehouseLine) { setPickingWarehouseLine(null); return; }
        if (viewingBatchLine) { setViewingBatchLine(null); return; }
        if (editingAllocLine) { setEditingAllocLine(null); return; }
        // Sale details is layered above the cart: Esc closes it instead of
        // removing the line the cart cursor happens to rest on (the removal
        // gesture further down).
        if (showSaleDetails) { closeSaleDetails(); return; }
        // Esc inside a pos cart field closes the field in one press (blur +
        // drop the ring), so the next Esc removes the line; other inputs just
        // blur.
        if (isEditable(e.target)) {
          const el = e.target as HTMLElement;
          if (el.id.startsWith('pos-')) { el.blur(); setActiveCartField(null); }
          else el.blur();
          return;
        }
        // Deselect the field cursor first, then the line itself — Esc on a
        // selected line is the removal gesture, and it is undoable.
        if (activeCartField !== null) { setActiveCartField(null); return; }
        if (activeCartLine !== null && cart[activeCartLine]) {
          removeCartLine(cart[activeCartLine]);
          return;
        }
        if (showMobileCart) { setShowMobileCart(false); return; }
        if (cartMaximized) { setCartMaximized(false); return; }
        return;
      }
      // Ctrl+Enter never inserts text, so it stays live even while typing;
      // Shift-letters would insert capitals, so they wait until below the
      // isEditable guard, as do "/" and "?".
      if (showCheckout) return;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        openCheckout();
        return;
      }
      // Shift+←/→ moves the field cursor even while a cart field input is
      // focused (it blurs the input first), so cycling never dead-ends after
      // Enter focuses a field. Inside any other editable (search box, notes)
      // Shift+arrows keep their native text-selection role.
      if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const el = e.target;
        const inCartField = el instanceof HTMLElement && isEditable(el) && el.id.startsWith('pos-');
        if (isEditable(el) && !inCartField) return;
        if (activeCartLine === null || !cart[activeCartLine]) return;
        e.preventDefault();
        if (inCartField) (el as HTMLElement).blur();
        const fields = cartLineFields(cart[activeCartLine]);
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        setActiveCartField(i => i === null ? (dir === 1 ? 0 : fields.length - 1) : (i + dir + fields.length) % fields.length);
        return;
      }
      if (isEditable(e.target)) return;
      // e.code distinguishes the physical key, so Shift+S etc. and any
      // uppercase the layout produces both match; bare modifiers are excluded
      // so system shortcuts like Ctrl+Shift+... are never hijacked.
      const shiftKey = e.code.startsWith('Key') && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (shiftKey && e.code === 'KeyN') {
        e.preventDefault();
        if (cart.length > 0 && !processing) clearCartWithUndo();
        return;
      }
      if (shiftKey && e.code === 'KeyP') {
        e.preventDefault();
        openCheckout();
        return;
      }
      if (shiftKey && e.code === 'KeyL') {
        e.preventDefault();
        if (cart.length > 0) toggleSaleDetails();
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      // Cart navigation: ↑/↓ move the line cursor, plain ←/→ nudge its
      // quantity (may rest at 0 without dropping the line), Enter selects the
      // field under the cursor, Esc removes the line. Shift+←/→ is
      // handled above the isEditable guard; everything here waits until after
      // it so typed text and native caret moves are never eaten.
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (cart.length === 0) return;
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        setActiveCartField(null);
        setActiveCartLine(i => {
          if (i === null) return dir === 1 ? 0 : cart.length - 1;
          return Math.min(cart.length - 1, Math.max(0, i + dir));
        });
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (activeCartLine === null || !cart[activeCartLine]) return;
        e.preventDefault();
        const line = cart[activeCartLine];
        updateQty(line.id, line.selected_unit?.id, e.key === 'ArrowRight' ? 1 : -1, true);
        return;
      }
      if (e.key === 'Enter') {
        if (activeCartLine === null || !cart[activeCartLine]) return;
        e.preventDefault();
        const item = cart[activeCartLine];
        const key = CSS.escape(lineIdOf(item));
        const fields = cartLineFields(item);
        const field = fields[activeCartField ?? fields.findIndex(f => f.kind === 'qty')];
        if (!field) return;
        const el = document.getElementById(`pos-${field.kind}-${key}`);
        if (el instanceof HTMLElement) {
          if (field.kind === 'wh' || field.kind === 'batch') el.click();
          else el.focus();
        }
        return;
      }
      if (e.key === '?') { e.preventDefault(); setShowShortcuts(true); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  // `allocation` is in the deps because cartLineFields() reads it via
  // lineAllocation() — without it the handler computes stale field lists (e.g.
  // no Batch button) until some other dep happens to change.
  }, [showCheckout, showShortcuts, showSaleDetails, showMobileCart, cartMaximized, cart.length, cart, activeCartLine, activeCartField, processing, pickingWarehouseLine, viewingBatchLine, editingAllocLine, allocation, removeCartLine, clearCartWithUndo]);
  const [defaultProductImage, setDefaultProductImage] = useState('');
  const [showImageModal, setShowImageModal] = useState(false);
  const [imageModalProduct, setImageModalProduct] = useState<ProductData | null>(null);
  const [imageModalUrl, setImageModalUrl] = useState('');
  const [imageModalIsDefault, setImageModalIsDefault] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerDropdownOpen, setCustomerDropdownOpen] = useState(false);
  // Keyboard-navigable customer dropdown: -1 = Walk-in row, n = customerMatches[n].
  const [customerActiveIndex, setCustomerActiveIndex] = useState(-1);
  const customerListboxId = `${useId()}-customer-listbox`;
  const [showCostPrice, setShowCostPrice] = useState<string | null>(null);
  const [draggedItem, setDraggedItem] = useState<number | null>(null);
  const [dragOverItem, setDragOverItem] = useState<number | null>(null);

  // Keep the keyboard line cursor inside the list as lines appear/disappear
  // (qty hitting 0 removes a line, Shift+N empties the cart).
  useEffect(() => {
    if (activeCartLine === null) return;
    if (cart.length === 0) {
      setActiveCartLine(null);
      setActiveCartField(null);
    } else if (activeCartLine >= cart.length) setActiveCartLine(cart.length - 1);
  }, [cart.length, activeCartLine]);

  // The line cursor must stay visible — scroll its row into view on move.
  useEffect(() => {
    if (activeCartLine === null || !cart[activeCartLine]) return;
    const el = document.getElementById(`pos-line-${CSS.escape(lineIdOf(cart[activeCartLine]))}`);
    el?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCartLine]);

  useEffect(() => {
    if (!customerDropdownOpen) return;
    const handler = () => setCustomerDropdownOpen(false);
    setTimeout(() => window.addEventListener('click', handler), 0);
    return () => window.removeEventListener('click', handler);
  }, [customerDropdownOpen]);

  const customerTokens = tokenizeSearch(customerSearch);
  // The walk-in record is pinned as its own row at the top of the list, so it
  // must not also appear in the match pool — it used to render twice (once
  // hardcoded, once from the alphabetical list).
  const walkInCustomer = useMemo(
    () => customers.find(c => c.id === walkInCustomerId) || null,
    [customers, walkInCustomerId],
  );
  const customerPool = useMemo(
    () => customers.filter(c => c.id !== walkInCustomerId),
    [customers, walkInCustomerId],
  );
  const customerMatches = useMemo(
    () => customerTokens.length === 0
      ? customerPool.slice(0, CUSTOMER_MATCH_LIMIT)
      // Rank the FULL match set before capping — slicing first would hide the
      // best match behind alphabetically-earlier rows.
      : rankRows(
          customerPool.filter(c => matchesTokens(c, CUSTOMER_SEARCH_COLUMNS, customerTokens)),
          customerRankColumns,
          customerTokens,
        ).slice(0, CUSTOMER_MATCH_LIMIT),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [customerPool, customerSearch],
  );

  // Brand / category pickers use the same tokenised predicate as every other
  // search in the page, so "foods fresh" finds "Fresh Foods Ltd" — the old
  // single-substring `.includes()` only matched the words in the typed order.
  // Ranking keeps a prefix hit ("Fre…") above a mid-word one ("…foods").
  const brandTokens = tokenizeSearch(brandSearch);
  const brandMatches = useMemo(
    () => brandTokens.length === 0
      ? brands
      : rankRows(
          brands.filter(b => matchesTokens(b, ['name'], brandTokens)),
          b => [b.name],
          brandTokens,
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [brands, brandSearch],
  );
  const categoryTokens = tokenizeSearch(categorySearch);
  const categoryMatches = useMemo(
    () => categoryTokens.length === 0
      ? categories
      : rankRows(
          categories.filter(c => matchesTokens(c, ['name'], categoryTokens)),
          c => [c.name],
          categoryTokens,
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [categories, categorySearch],
  );

  useEffect(() => { setCustomerActiveIndex(customerMatches.length > 0 ? 0 : -1); }, [customerSearch]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (customerActiveIndex < 0 || !customerDropdownOpen) return;
    document.getElementById(`${customerListboxId}-option-${customerActiveIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [customerActiveIndex, customerDropdownOpen, customerListboxId]);

  function handleCustomerSelect(id: string) {
    setSelectedCustomer(id);
    setCustomerDropdownOpen(false);
    setCustomerSearch('');
    setCustomerActiveIndex(-1);
  }

  // A customer deactivated (the CRM's "delete" is a soft delete) on another
  // device must not stay selected by id alone. `customers` is filtered to
  // active rows, so the trigger already falls back to the walk-in LABEL — but
  // `selectedCustomer` still holds the old id, and isRegisteredCustomer plus
  // the invoice header keep using it. The till would read "Walk-in Customer"
  // while the sale was billed to a deactivated account. Drop the selection.
  useEffect(() => {
    if (!selectedCustomer || selectedCustomer === walkInCustomerId) return;
    // Nothing loaded yet (first paint, or every read failed) is not evidence
    // that the customer disappeared — only a non-empty list is.
    if (customers.length === 0) return;
    if (customers.some(c => c.id === selectedCustomer)) return;
    setSelectedCustomer(walkInCustomerId);
  }, [customers, selectedCustomer, walkInCustomerId]);

  function handleCustomerKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape' && customerDropdownOpen) {
      e.preventDefault(); e.stopPropagation();
      setCustomerDropdownOpen(false);
      return;
    }
    if (customerMatches.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCustomerActiveIndex(i => Math.min(i + 1, customerMatches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCustomerActiveIndex(i => Math.max(i - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (customerActiveIndex >= 0) handleCustomerSelect(customerMatches[customerActiveIndex].id);
      else handleCustomerSelect(walkInCustomerId);
    }
  }

  // Cart footer: a fixed-height action bar (Sale details · Total · Pay) with a
  // "Sale details" panel that rises above it. Rendered in flow inside the
  // panel; while pinned, the same content is portaled as a fixed bar at the
  // viewport bottom and the in-flow copy is only hidden.
  const adjustmentCount =
    (discount > 0 ? 1 : 0) +
    (extraDiscount > 0 ? 1 : 0) +
    (shipping > 0 ? 1 : 0) +
    (vatSettings.enabled && applyVat ? 1 : 0);
  const renderCartFooter = (extraClass: string, inFlow: boolean) => {
    const panelId = inFlow ? saleDetailsId : `${saleDetailsId}-pinned`;
    return (
      <div
        ref={inFlow ? cartFooterRef : undefined}
        className={`relative border-t border-border bg-white ${extraClass}`}
        style={inFlow ? undefined : { position: 'fixed', bottom: 0, left: footerBarRect.left, width: footerBarRect.width, zIndex: 90, boxShadow: '0 -4px 12px rgba(15, 23, 42, 0.08)' }}
      >
        {/* Applied adjustments stay readable while the panel is closed — a
            discount or charge must never be invisible behind the disclosure.
            Fixed-height row so opening/closing (and clearing an adjustment
            while the panel is open) never reflows the list or the bar. */}
        <div className="flex h-6 items-center px-3 text-[11px]">
          {adjustmentCount > 0 ? (
            <span className="truncate text-muted-foreground">
              {[
                discount > 0 ? `Discount ${discount}% (−${formatCurrency(cartDiscountAmount)})` : null,
                extraDiscount > 0 ? `Extra −${formatCurrency(extraDiscount)}` : null,
                shipping > 0 ? `Shipping +${formatCurrency(shipping)}` : null,
                vatSettings.enabled && applyVat ? `VAT +${formatCurrency(posVat.taxAmount)}` : null,
              ].filter(Boolean).join(' · ')}
            </span>
          ) : (
            <span className="text-muted-foreground/70">No discounts or charges</span>
          )}
        </div>

        {/* Action row — never moves: the disclosure grows upward, not the bar. */}
        <div className="flex items-center gap-2 px-2.5 py-2">
          <button
            onClick={toggleSaleDetails}
            aria-expanded={showSaleDetails}
            aria-controls={panelId}
            data-sale-details-toggle
            title="Invoice date, reference, discounts and charges (Shift+L)"
            className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2 min-[380px]:px-2.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${showSaleDetails ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-border bg-white text-foreground hover:bg-muted/70'}`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span className="hidden min-[380px]:inline">Sale details</span>
            <span className="min-[380px]:hidden">Details</span>
            {adjustmentCount > 0 && (
              <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-bold leading-none text-white">
                {adjustmentCount}
              </span>
            )}
            <ChevronUp className={`w-3.5 h-3.5 text-muted-foreground transition-transform duration-200 ${showSaleDetails ? 'rotate-180' : ''}`} />
          </button>

          <div className="ml-auto min-w-0 shrink-0 text-right leading-none">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Total</div>
            <div className="mt-1 truncate text-[15px] font-bold tabular-nums text-foreground">{formatCurrency(grandTotal)}</div>
          </div>

          <button
            onClick={openCheckout}
            disabled={processing || !selectedCustomer}
            title={!selectedCustomer ? 'Select a customer to continue' : undefined}
            className="shrink-0 bg-blue-600 hover:bg-blue-700 text-white font-bold h-9 px-3 min-[420px]:px-3.5 rounded-lg transition disabled:opacity-60 text-sm flex items-center gap-1.5"
          >
            <Receipt className="w-4 h-4" />
            Pay
            <kbd className="hidden min-[420px]:inline rounded bg-white/20 px-1 text-[10px] font-semibold leading-4">⇧P</kbd>
          </button>
        </div>

        {showSaleDetails && (
          <div
            id={panelId}
            data-sale-details-panel
            role="region"
            aria-label="Sale details"
            tabIndex={-1}
            className="animate-sheet-up absolute inset-x-0 bottom-full z-20 flex max-h-[min(60vh,460px)] flex-col overflow-hidden rounded-t-2xl border border-b-0 border-border bg-white shadow-[0_-16px_40px_-12px_rgba(15,23,42,0.28)] focus:outline-none"
          >
            <div className="flex items-start justify-between gap-3 border-b border-border px-3 pb-2 pt-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Sale details</h3>
                <p className="text-[11px] text-muted-foreground">Optional fields and adjustments for this invoice</p>
              </div>
              <button
                onClick={closeSaleDetails}
                aria-label="Close sale details"
                className="-mr-1 -mt-0.5 rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-3 py-3">
              <section className="space-y-2">
                <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Invoice</h4>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label htmlFor={`${panelId}-date`} className="mb-1 block text-[11px] font-medium text-muted-foreground">Date</label>
                    <input id={`${panelId}-date`} type="date" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} className="h-8 w-full rounded-lg border border-border px-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
                  </div>
                  <div>
                    <label htmlFor={`${panelId}-ref`} className="mb-1 block text-[11px] font-medium text-muted-foreground">Reference</label>
                    <input id={`${panelId}-ref`} type="text" value={reference} onChange={e => setReference(e.target.value)} className="h-8 w-full rounded-lg border border-border px-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20" placeholder="Person or note" />
                  </div>
                </div>
              </section>

              {/* No "Adjustments" heading: the three fields are self-describing
                  and the row of space it cost was what pushed the summary out of
                  view. The two discounts put their label above a full-cell-width
                  input (matching the Invoice fields), which more than doubles the
                  input width at every size — 80px -> 176px on a 390px sheet.
                  Shipping keeps its label inline because its label is long and
                  the input still grows into whatever width is left (max 12rem). */}
              <section>
                <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                  <div className="min-w-0">
                    <label htmlFor={`${panelId}-disc`} className="mb-1 block text-[11px] font-medium text-muted-foreground">Cart discount</label>
                    <UnitInput id={`${panelId}-disc`} unit="%" min="0" max="100" value={discount} onChange={e => setDiscount(Number(e.target.value))} className="h-10 rounded-lg text-sm" />
                  </div>
                  <div className="min-w-0">
                    <label htmlFor={`${panelId}-extra`} className="mb-1 block text-[11px] font-medium text-muted-foreground">Extra discount</label>
                    <UnitInput id={`${panelId}-extra`} prefix="৳" min="0" step="0.01" value={extraDiscount} onChange={e => setExtraDiscount(Number(e.target.value) || 0)} className="h-10 rounded-lg text-sm" />
                  </div>
                  <div className="col-span-2 flex min-w-0 items-center justify-between gap-2">
                    <label htmlFor={`${panelId}-ship`} className="min-w-0 truncate text-[11px] font-medium text-muted-foreground">Shipping / service fee</label>
                    <div className="min-w-0 max-w-[12rem] flex-1">
                      <UnitInput id={`${panelId}-ship`} prefix="৳" min="0" step="0.01" value={shipping} onChange={e => setShipping(Number(e.target.value) || 0)} className="h-10 rounded-lg text-sm" />
                    </div>
                  </div>
                </div>
              </section>

              <section className="space-y-0.5 text-sm">
                <h4 className="pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Summary</h4>
                <div className="flex justify-between text-muted-foreground"><span>Subtotal</span><span className="tabular-nums">{formatCurrency(subtotal + itemDiscountTotal)}</span></div>
                {itemDiscountTotal > 0 && <div className="flex justify-between text-amber-600"><span>Item discounts</span><span className="tabular-nums">-{formatCurrency(itemDiscountTotal)}</span></div>}
                {discount > 0 && <div className="flex justify-between text-red-500"><span>Cart discount ({discount}%)</span><span className="tabular-nums">-{formatCurrency(cartDiscountAmount)}</span></div>}
                {extraDiscount > 0 && <div className="flex justify-between text-red-500"><span>Extra discount</span><span className="tabular-nums">-{formatCurrency(extraDiscount)}</span></div>}
                {shipping > 0 && <div className="flex justify-between text-blue-700"><span>Shipping / service fee</span><span className="tabular-nums">+{formatCurrency(shipping)}</span></div>}
                {vatSettings.enabled && (
                  <div className="flex justify-between items-center pt-1 border-t border-border">
                    <label htmlFor={`${panelId}-vat`} className="flex items-center gap-2 text-xs font-medium text-muted-foreground cursor-pointer">
                      <input
                        id={`${panelId}-vat`}
                        type="checkbox"
                        checked={applyVat}
                        onChange={e => setApplyVat(e.target.checked)}
                        className="w-3.5 h-3.5 accent-blue-600"
                      />
                      VAT ({vatSettings.rate}%{vatSettings.mode === 'inclusive' ? ', in prices' : ''})
                    </label>
                    {applyVat && <span className="text-xs text-blue-700 font-medium tabular-nums">+{formatCurrency(posVat.taxAmount)}</span>}
                  </div>
                )}
                {/* Pinned so Total never scrolls away. Merging the two
                    discounts makes the untouched sheet fit exactly, but the
                    moment a discount is entered the summary grows a line and
                    Total drops below the fold again (measured: 66px out of
                    view). Sticky costs nothing when everything already fits.
                    -mx-3/px-3 let the white background span the pane so lines
                    do not show through the side padding while scrolling. */}
                <div className="sticky bottom-0 -mx-3 flex justify-between border-t border-border bg-white px-3 pt-1 text-base font-bold text-foreground"><span>Total</span><span className="tabular-nums">{formatCurrency(grandTotal)}</span></div>
              </section>
            </div>

            <div className="border-t border-border px-3 py-2">
              <button
                onClick={closeSaleDetails}
                className="h-9 w-full rounded-lg border border-border bg-white text-sm font-semibold text-foreground transition hover:bg-muted"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div ref={posRootRef} className="flex flex-col lg:flex-row lg:h-[var(--pos-h,calc(100dvh_-_104px))] transition-[height] duration-300 ease-out gap-4 animate-fade-in">
      {/* Mobile Cart Overlay */}
      {showMobileCart && (
        <div
          className="fixed inset-0 bg-black/40 z-40 lg:hidden"
          style={{ touchAction: 'none' }}
          onClick={() => setShowMobileCart(false)}
        />
      )}
      {/* Maximized Cart Backdrop (desktop) */}
      {cartMaximized && (
        <div
          className="fixed inset-0 bg-black/40 z-[90] hidden lg:block"
          onClick={() => setCartMaximized(false)}
        />
      )}

      {/* Mobile cart bar — the only cart entry point on a phone. The controls
          row scrolls away with the products and the sheet is off-screen until
          opened, so the order needs a permanent, thumb-reachable anchor that
          also carries the running total. */}
      <button
        type="button"
        onClick={() => setShowMobileCart(true)}
        aria-label={cart.length > 0
          ? `Cart, ${cart.length} item${cart.length === 1 ? '' : 's'}, total ${formatCurrency(grandTotal)}. Open cart`
          : 'Cart is empty. Open cart'}
        className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-between gap-3 border-t border-border bg-white px-4 py-3 shadow-[0_-6px_20px_-8px_rgba(15,23,42,0.25)] transition hover:bg-muted/30 active:bg-muted/50 lg:hidden"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
      >
        <span className="flex min-w-0 items-center gap-4">
          <span className="relative shrink-0">
            <ShoppingCart className="h-5 w-5 text-blue-600" />
            {cart.length > 0 && (
              <span className="absolute -right-2.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-bold leading-none text-white">
                {cart.length}
              </span>
            )}
          </span>
          <span className="min-w-0 truncate text-sm font-semibold text-foreground">
            {cart.length > 0 ? 'View cart' : 'Cart is empty'}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {cart.length > 0 && (
            <span className="text-base font-bold tabular-nums text-foreground">{formatCurrency(grandTotal)}</span>
          )}
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        </span>
      </button>

      {/* Left panel — mobile: natural scroll, desktop: flex-col with overflow */}
      <div className="flex-1 flex flex-col min-w-0 lg:overflow-hidden">
        {/* Controls row */}
        <div className="flex flex-col gap-2 mb-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
          <div className="relative flex-1 sm:basis-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              ref={searchInputRef}
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                void addScannedOrSingleMatch();
              }}
              placeholder="Search products by name, SKU or barcode..."
              className="w-full pl-10 pr-10 py-2.5 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 bg-white"
            />
            <kbd className="absolute right-3 top-1/2 -translate-y-1/2 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground pointer-events-none">/</kbd>
          </div>
          {/* Filters + scan share one row on phones. Each used to be its own
              full-width row of the mobile column holding a ~38px icon, costing
              ~114px of vertical space before the first product. A 3-column grid
              splits the width exactly; from sm up the wrapper is `contents`, so
              the buttons become direct children of the controls row and the
              desktop layout is untouched.

              This wrapper is `relative` because the filter dropdowns anchor to
              it on phones: a ~114px button cannot host a 224px panel, so
              `right-0 w-56` pushed the brand list ~94px off the left edge of
              the screen. The panels are `left-0 right-0` here (full row width)
              and only fall back to per-button `sm:right-0 sm:w-56` once the
              wrapper is `contents`. Moving or un-positioning this div will
              re-break the dropdowns. */}
          <div className="relative grid grid-cols-3 gap-2 sm:contents">
          {/* Brand filter — icon-only until a brand is picked, then shows its name */}
          <div className="min-w-0 sm:relative">
            <button
              type="button"
              onClick={() => setBrandDropdownOpen(!brandDropdownOpen)}
              className={`flex w-full items-center justify-center gap-1.5 border rounded-xl px-2.5 py-2.5 text-sm bg-white hover:border-blue-300 focus:outline-none focus:border-blue-500 transition sm:w-auto sm:justify-start ${
                selectedBrand ? 'border-blue-500 text-blue-600' : 'border-border text-muted-foreground'
              }`}
              title="Filter by brand"
            >
              <Tag className="w-4 h-4 shrink-0" />
              {selectedBrand && (
                <>
                  <span className="min-w-0 max-w-[100px] truncate">{brands.find(b => b.id === selectedBrand)?.name}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); setSelectedBrand(''); setBrandSearch(''); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); setSelectedBrand(''); setBrandSearch(''); } }}
                    className="ml-0.5 shrink-0 hover:text-red-500"
                  >
                    <X className="w-3 h-3" />
                  </span>
                </>
              )}
            </button>
            {brandDropdownOpen && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-border rounded-lg shadow-lg z-50 overflow-hidden sm:left-auto sm:right-0 sm:w-56">
                <div className="p-2 border-b border-border">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <input
                      type="text"
                      value={brandSearch}
                      onChange={e => setBrandSearch(e.target.value)}
                      placeholder="Search brands..."
                      className="w-full pl-8 pr-3 py-1.5 text-sm border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                      autoFocus
                    />
                  </div>
                </div>
                <div className="max-h-48 overflow-y-auto">
                  <button
                    type="button"
                    onClick={() => { setSelectedBrand(''); setBrandDropdownOpen(false); setBrandSearch(''); }}
                    className={`w-full flex items-center px-3 py-2 text-sm hover:bg-blue-50 transition text-left ${!selectedBrand ? 'bg-blue-50 text-blue-600' : 'text-muted-foreground'}`}
                  >
                    All Brands
                  </button>
                  {brandMatches.map(b => (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => { setSelectedBrand(b.id); setBrandDropdownOpen(false); setBrandSearch(''); }}
                      className={`w-full flex items-center px-3 py-2 text-sm hover:bg-blue-50 transition text-left ${selectedBrand === b.id ? 'bg-blue-50 text-blue-600' : 'text-foreground'}`}
                    >
                      {brandTokens.length > 0 ? <HighlightLabel text={b.name} query={brandSearch} /> : b.name}
                    </button>
                  ))}
                  {brandSearch.trim() && brandMatches.length === 0 && (
                    <div className="px-3 py-3 text-center text-xs text-muted-foreground">No brands found</div>
                  )}
                </div>
              </div>
            )}
          </div>
          {/* Category filter — icon-only until a category is picked, then shows its name */}
          <div className="min-w-0 sm:relative">
            <button
              type="button"
              onClick={() => setCategoryDropdownOpen(!categoryDropdownOpen)}
              className={`flex w-full items-center justify-center gap-1.5 border rounded-xl px-2.5 py-2.5 text-sm bg-white hover:border-blue-300 focus:outline-none focus:border-blue-500 transition sm:w-auto sm:justify-start ${
                selectedCategory ? 'border-blue-500 text-blue-600' : 'border-border text-muted-foreground'
              }`}
              title="Filter by category"
            >
              <LayoutGrid className="w-4 h-4 shrink-0" />
              {selectedCategory && (
                <>
                  <span className="min-w-0 max-w-[100px] truncate">{categories.find(c => c.id === selectedCategory)?.name}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); setSelectedCategory(''); setCategorySearch(''); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); setSelectedCategory(''); setCategorySearch(''); } }}
                    className="ml-0.5 shrink-0 hover:text-red-500"
                  >
                    <X className="w-3 h-3" />
                  </span>
                </>
              )}
            </button>
            {categoryDropdownOpen && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-border rounded-lg shadow-lg z-50 overflow-hidden sm:left-auto sm:right-0 sm:w-56">
                <div className="p-2 border-b border-border">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <input
                      type="text"
                      value={categorySearch}
                      onChange={e => setCategorySearch(e.target.value)}
                      placeholder="Search categories..."
                      className="w-full pl-8 pr-3 py-1.5 text-sm border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                      autoFocus
                    />
                  </div>
                </div>
                <div className="max-h-48 overflow-y-auto">
                  <button
                    type="button"
                    onClick={() => { setSelectedCategory(''); setCategoryDropdownOpen(false); setCategorySearch(''); }}
                    className={`w-full flex items-center px-3 py-2 text-sm hover:bg-blue-50 transition text-left ${!selectedCategory ? 'bg-blue-50 text-blue-600' : 'text-muted-foreground'}`}
                  >
                    All Categories
                  </button>
                  {categoryMatches.map(c => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => { setSelectedCategory(c.id); setCategoryDropdownOpen(false); setCategorySearch(''); }}
                      className={`w-full flex items-center px-3 py-2 text-sm hover:bg-blue-50 transition text-left ${selectedCategory === c.id ? 'bg-blue-50 text-blue-600' : 'text-foreground'}`}
                    >
                      {categoryTokens.length > 0 ? <HighlightLabel text={c.name} query={categorySearch} /> : c.name}
                    </button>
                  ))}
                  {categorySearch.trim() && categoryMatches.length === 0 && (
                    <div className="px-3 py-3 text-center text-xs text-muted-foreground">No categories found</div>
                  )}
                </div>
              </div>
            )}
          </div>
            <button
              onClick={() => setShowScanner(true)}
              title="Scan Barcode"
              aria-label="Scan barcode"
              className="flex w-full min-w-0 items-center justify-center gap-2 border border-border bg-white rounded-xl px-2.5 py-2.5 text-sm hover:bg-muted transition text-muted-foreground hover:text-foreground sm:w-auto"
            >
              <Camera className="w-4 h-4" />
              <span className="hidden sm:inline">Scan</span>
            </button>
          </div>
          {/* The cart's mobile entry point is the persistent bottom bar, not
              a button here: this row scrolls away with the products. */}
          <div className="flex items-center gap-2 relative">
            {/* Searchable Customer Selector */}
            <div className="flex-1 sm:flex-none relative">
              <button
                onClick={(e) => { e.stopPropagation(); setCustomerDropdownOpen(!customerDropdownOpen); }}
                className="flex items-center gap-2 border border-border rounded-xl px-3 py-2.5 text-sm bg-white hover:bg-muted/50 transition sm:min-w-[200px] w-full"
              >
                <span className="text-muted-foreground shrink-0"><UserPlus className="w-3.5 h-3.5" /></span>
                <span className="flex-1 text-left truncate">
                  {selectedCustomer
                    ? (customers.find(c => c.id === selectedCustomer)?.name || 'Walk-in Customer')
                    : 'Select Customer'}
                </span>
                <span className="text-xs text-muted-foreground shrink-0">▾</span>
              </button>
              {customerDropdownOpen && (
                <div className="absolute top-full mt-1 left-0 right-0 sm:w-80 bg-white border border-border rounded-xl shadow-lg z-50 overflow-hidden" onClick={(e) => e.stopPropagation()}>
                  <div className="p-2 border-b border-border">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                      <input
                        type="text"
                        role="combobox"
                        aria-expanded
                        aria-controls={customerListboxId}
                        aria-activedescendant={customerActiveIndex >= 0 ? `${customerListboxId}-option-${customerActiveIndex}` : customerActiveIndex === -1 ? `${customerListboxId}-option-walkin` : undefined}
                        aria-autocomplete="list"
                        value={customerSearch}
                        onChange={e => setCustomerSearch(e.target.value)}
                        onKeyDown={handleCustomerKeyDown}
                        placeholder="Search customers..."
                        autoFocus
                        className="w-full pl-8 pr-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:border-blue-400"
                      />
                    </div>
                  </div>
                  <div role="listbox" id={customerListboxId} className="max-h-72 overflow-y-auto">
                    <button
                      type="button"
                      role="option"
                      id={`${customerListboxId}-option-walkin`}
                      aria-selected={customerActiveIndex === -1}
                      onClick={() => handleCustomerSelect(walkInCustomerId)}
                      className={`w-full flex flex-col px-3 py-2 transition text-left ${customerActiveIndex === -1 || selectedCustomer === walkInCustomerId ? 'bg-blue-50 text-blue-600' : 'text-foreground hover:bg-blue-50'}`}
                    >
                      {/* Pinned "no customer" option. Its name and code come
                          from the resolved walk-in record — a literal
                          `CUST-272756` here was one tenant's data baked into
                          the source and went stale for everyone else. */}
                      <span className="text-sm font-medium">{walkInCustomer?.name || 'Walk-in Customer'}</span>
                      <span className="text-[10px] text-muted-foreground">{walkInCustomer?.code || '—'}</span>
                    </button>
                    {customerMatches.map((c, i) => (
                      <button
                        key={c.id}
                        type="button"
                        role="option"
                        id={`${customerListboxId}-option-${i}`}
                        aria-selected={i === customerActiveIndex}
                        onClick={() => handleCustomerSelect(c.id)}
                        className={`w-full flex flex-col px-3 py-2 transition text-left border-t border-border/40 ${i === customerActiveIndex ? 'bg-blue-50' : 'hover:bg-blue-50'} ${selectedCustomer === c.id ? 'text-blue-600' : 'text-foreground'}`}
                      >
                        <span className="text-sm font-medium leading-tight break-words">
                          {customerTokens.length > 0 ? <HighlightLabel text={c.name} query={customerSearch} /> : c.name}
                        </span>
                        {c.company_name && (
                          <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{c.company_name}</span>
                        )}
                        <div className="flex items-center gap-2 mt-0.5">
                          {Number(c.outstanding_balance) > 0 && (
                            <span className="text-[10px] font-medium text-amber-600">
                              Due: {Number(c.outstanding_balance).toLocaleString('en-BD', { minimumFractionDigits: 0 })}
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground">{c.code}</span>
                          {/* `mobile` is searched now, so it has to be visible —
                              otherwise a mobile-number hit looks unexplained. */}
                          {(c.phone || c.mobile) && (
                            <span className="text-[10px] text-muted-foreground">· {c.phone || c.mobile}</span>
                          )}
                        </div>
                      </button>
                    ))}
                    {customerSearch.trim() && customerMatches.length === 0 && (
                      <div className="px-3 py-4 text-center text-xs text-muted-foreground">No customers found</div>
                    )}
                    {!customerSearch.trim() && customerPool.length > CUSTOMER_MATCH_LIMIT && (
                      <div className="border-t border-border/40 px-3 py-2 text-center text-[11px] text-muted-foreground">
                        Showing {CUSTOMER_MATCH_LIMIT} of {customerPool.length} — type to narrow
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <button
              onClick={() => setShowAddCustomer(true)}
              title="Add New Customer"
              className="flex items-center justify-center gap-1.5 border border-blue-500 text-blue-600 rounded-xl px-3 py-2.5 text-sm hover:bg-blue-50 transition shrink-0"
            >
              <UserPlus className="w-4 h-4" />
              <span className="hidden sm:inline">New</span>
            </button>
          </div>
        </div>

        {/* Product grid — natural flow on mobile, overflow-y-auto on desktop */}
        <div aria-label="Product gallery" aria-busy={loading || loadingMore} className="grid grid-cols-2 md:grid-cols-3 gap-2.5 content-start pb-28 lg:pb-4 lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
          {loading ? Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-border p-2.5 animate-pulse"><div className="h-16 bg-muted rounded-lg mb-1.5" /><div className="h-3 bg-muted rounded mb-1" /><div className="h-3 bg-muted rounded w-2/3" /></div>
          )) : filteredProducts.length === 0 ? (
            <div className="col-span-full text-center py-12 text-muted-foreground">
              {search ? `No products found for "${search}"` : 'No products found'}
            </div>
          ) : filteredProducts.map(p => {
            const multiUnit = isMultiUnitEnabled(p as any);
            const saleUnit = p.units?.find(u => u.is_sale_unit);
            const displayPrice = saleUnit?.price || p.sale_price;

            // Batch-ledger availability minus cart reservations (spec §18);
            // counter fallback when the product has no batch rows.
            const stockInfo = getProductAvailable(p);
            const available = stockInfo.available;

            return (
              <div
                key={p.id}
                className="bg-white rounded-xl border border-border p-2.5 text-left hover:border-blue-400 hover:shadow-md transition-all group relative"
              >
                {/* group class stays for image-btn opacity; cost overlay uses a separate nested group below */}
                {/* Image change button (top-right, appears on hover) */}
                <button
                  onClick={(e) => { e.stopPropagation(); setImageModalProduct(p); setImageModalUrl(p.image_url || ''); setImageModalIsDefault(false); setShowImageModal(true); }}
                  className="absolute top-1.5 right-1.5 z-20 w-6 h-6 bg-white/90 rounded-full flex items-center justify-center text-muted-foreground hover:text-blue-600 hover:bg-blue-50 shadow-sm opacity-0 group-hover:opacity-100 transition"
                  title="Change product image"
                >
                  <ImagePlus className="w-3.5 h-3.5" />
                </button>

                <div onClick={() => (available > 0 || invSettings.allow_oversell) && handleProductClick(p)} className={available <= 0 && !invSettings.allow_oversell ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}>
                  {multiUnit && (
                    <span className="absolute top-2 left-2 text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium z-10">Multi-unit</span>
                  )}
                  <div className="w-full h-16 bg-muted rounded-lg overflow-hidden mb-1.5 relative">
                    {p.image_url || defaultProductImage ? (
                      <img
                        src={p.image_url || defaultProductImage}
                        alt={p.name}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden'); }}
                      />
                    ) : null}
                    {(!p.image_url && !defaultProductImage) || true ? (
                      <div className={`w-full h-full flex items-center justify-center text-muted-foreground ${(p.image_url || defaultProductImage) ? 'hidden' : ''}`}>
                        <Package className="w-8 h-8 text-muted-foreground/40" />
                      </div>
                    ) : null}
                  </div>
                  <p className="text-xs font-semibold text-foreground leading-tight mb-0.5 break-words">{p.name}</p>
                  <p className="text-[10px] text-muted-foreground mb-1">{p.sku}</p>
                  <div className="flex items-center justify-between">
                    {/* Price area — hovering here reveals cost/profit tooltip */}
                    <div className="relative group/price">
                      <p className="text-sm font-bold text-blue-600 cursor-default">{formatCurrency(displayPrice)}</p>
                      {multiUnit && saleUnit && (
                        <p className="text-[9px] text-muted-foreground">per {saleUnit.unit_name}</p>
                      )}
                      {/* Cost price & profit tooltip — only visible on price area hover */}
                      <div
                        className="absolute bottom-full left-0 mb-1.5 z-30 min-w-[120px] bg-slate-800 text-white rounded-lg px-2.5 py-2 shadow-xl pointer-events-none opacity-0 group-hover/price:opacity-100 transition-opacity duration-150"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <p className="text-[9px] text-white/60 uppercase tracking-wide mb-0.5">Cost Price</p>
                        <p className="text-xs font-bold">{formatCurrency(p.cost_price || 0)}</p>
                        <p className="text-[10px] text-green-400 mt-0.5">
                          Profit: {formatCurrency((displayPrice || 0) - (p.cost_price || 0))}
                        </p>
                        {/* Small arrow */}
                        <div className="absolute top-full left-3 w-0 h-0 border-x-4 border-x-transparent border-t-4 border-t-slate-800" />
                      </div>
                    </div>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded ${available > 0 ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-500'}`}
                      title={stockInfo.batches > 0 ? `${stockInfo.batches} eligible batch${stockInfo.batches === 1 ? '' : 'es'} · ${strategy.toUpperCase()} allocation` : 'Counter stock (no batch ledger rows)'}
                    >{available}</span>
                  </div>
                </div>
              </div>
            );
          })}
          {!loading && products.length > 0 && (
            <div className="col-span-full flex flex-col sm:flex-row items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 p-3">
              <p role="status" className="text-xs text-muted-foreground">
                Showing {products.length}{matchCount !== null ? ` of ${matchCount}` : ''} products
                {!hasMoreProducts && ' · All products loaded'}
              </p>
              {hasMoreProducts && (
                <button
                  type="button"
                  onClick={() => loadProducts(search, true)}
                  disabled={loadingMore}
                  className="flex items-center justify-center gap-2 rounded-lg border border-blue-200 bg-white px-4 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:opacity-60 transition"
                >
                  <ChevronDown className={`w-4 h-4 ${loadingMore ? 'animate-pulse' : ''}`} />
                  {loadingMore ? 'Loading products...' : 'Load more products'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Cart - Desktop Side Panel / Mobile Bottom Drawer / Maximized Overlay.
          The class list must not carry a bare `relative`: it is emitted after
          `fixed` in Tailwind's output, so it silently won and turned the mobile
          sheet into an in-flow block at the end of the page. Desktop gets
          `lg:relative` from the first line below. */}
      <div
        ref={cartPanelRef}
        style={cartHeightOverride != null && !cartMaximized ? ({ '--cart-ovh': `${cartHeightOverride}px` } as CSSProperties) : undefined}
        className={`
        ${cartMaximized ? 'fixed inset-0 z-[100]' : 'fixed lg:relative inset-x-0 bottom-0 lg:inset-auto'}
        ${cartMaximized ? 'w-full h-full lg:w-full lg:h-full' : 'lg:w-[560px]'}
        flex flex-col bg-white
        ${cartMaximized ? 'rounded-none lg:rounded-none' : 'rounded-t-3xl lg:rounded-2xl'}
        border border-border shadow-sm overflow-hidden
        z-50
        transition-transform duration-300 ease-out lg:transition-[height]
        ${showMobileCart || cartMaximized ? 'translate-y-0' : 'translate-y-full lg:translate-y-0'}
        ${cartMaximized ? '' : 'h-[85vh] lg:h-[var(--cart-ovh,100%)]'}
      `}>
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h2 className="font-bold text-foreground flex items-center gap-2">
            <ShoppingCart className="w-4 h-4" />Cart ({cart.length})
          </h2>
          <div className="flex items-center gap-2">
            {cart.length >= 3 && !cartMaximized && (
              <button
                onClick={() => setCartAutoGrow(v => !v)}
                className="hidden lg:flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition"
                title={cartAutoGrow ? 'Stop auto-growing — the cart scrolls within the screen again' : 'Let the cart grow downward with items (up to 50)'}
              >
                <RotateCcw className="w-3 h-3" />
                {cartAutoGrow ? 'Reset size' : 'Auto-grow'}
              </button>
            )}
            {undoOffer && (
              <button
                onClick={() => {
                  const restore = undoOffer.restore;
                  setUndoOffer(null);
                  restore();
                }}
                title={undoOffer.label}
                aria-label={undoOffer.label}
                className="flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-1.5 py-1 text-xs font-semibold text-amber-700 transition hover:bg-amber-100"
              >
                <Undo2 className="w-3.5 h-3.5" />
                Undo
              </button>
            )}
            {cart.length > 0 && (
              <button
                onClick={clearCartWithUndo}
                title="Clear the cart — undo is offered"
                className="rounded-md px-1.5 py-1 text-xs text-red-500 transition hover:bg-red-50 hover:text-red-600"
              >
                Clear <kbd className="rounded border border-border bg-muted px-0.5 text-[9px] font-semibold text-muted-foreground">⇧N</kbd>
              </button>
            )}
            <button
              onClick={() => setShowShortcuts(true)}
              className="hidden lg:flex text-muted-foreground hover:text-foreground p-1 transition"
              title="Keyboard shortcuts (?)"
            >
              <Keyboard className="w-4 h-4" />
            </button>
            <button
              onClick={() => setCartMaximized(v => !v)}
              className="hidden lg:flex text-muted-foreground hover:text-foreground p-1 transition"
              title={cartMaximized ? 'Minimize cart' : 'Maximize cart'}
            >
              {cartMaximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
            <button
              onClick={() => setShowMobileCart(false)}
              aria-label="Close cart"
              className="lg:hidden -mr-1 rounded-md p-1.5 text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Cart tabs: Items | Cost Price History */}
        {cart.length > 0 && (
          <div className="flex border-b border-border">
            <button
              onClick={() => setCartTab('items')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold transition ${cartTab === 'items' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <ShoppingCart className="w-3.5 h-3.5" /> Items
            </button>
            <button
              onClick={() => setCartTab('cost')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold transition ${cartTab === 'cost' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <History className="w-3.5 h-3.5" /> Cost Price
            </button>
          </div>
        )}

        {/* Bounded pane: the list scrolls, the fades advertise it. The
            wrapper (not the scroller) carries the maximized width so the
            fades stay flush with the list. */}
        <div className={`relative grow shrink min-h-0 ${cartMaximized ? 'lg:max-w-4xl lg:mx-auto lg:w-full' : ''}`}>
          <div
            ref={cartListRef}
            onScroll={syncCartScrollEdges}
            className="h-full overflow-y-auto p-2.5 space-y-1.5"
          >
          {cart.length === 0 ? (
            <div className="min-h-full flex items-center justify-center text-center py-12">
              <div>
                <ShoppingCart className="w-12 h-12 text-muted-foreground/30 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">Cart is empty</p>
                <p className="text-xs text-muted-foreground">Click products to add</p>
              </div>
            </div>
          ) : cartTab === 'items' ? (
            cart.map((item, index) => {
              const lineTotal = item.quantity * item.unit_price * (1 - (item.discount_percent || 0) / 100);
              // Per-unit price after the line discount — shown beside the
              // discount box so staff can read the effective rate directly.
              const netUnitPrice = item.unit_price * (1 - (item.discount_percent || 0) / 100);
              const lineUnitLabel = item.selected_unit?.unit_short || item.selected_unit?.unit_name || item.unit || 'unit';
              const liKey = lineIdOf(item);
              const la = lineAllocation(item);
              // Keyboard field cursor: which control Shift+←/→ currently
              // points at (only when this line is the selected one).
              const lineFields = cartLineFields(item);
              const fieldSel = (kind: 'price' | 'disc' | 'wh' | 'batch' | 'qty') =>
                activeCartLine === index && activeCartField === lineFields.findIndex(f => f.kind === kind);
              // Warnings worth a red count on the batch button: a ledger
              // shortfall, and a manual override that no longer fits.
              const batchWarnCount = (la && la.shortfall > 1e-9 ? 1 : 0) + (la && la.overrideInvalid ? 1 : 0);
              // The button is the line's only batch affordance, so it also
              // shows when there is nothing allocated yet but the ledger
              // cannot cover the line — the warning needs a carrier.
              const hasBatchButton = !!la && (la.allocations.length > 0 || batchWarnCount > 0);
              const batchButtonTitle = hasBatchButton
                ? `Batch allocation — ${la!.allocations.length} batch${la!.allocations.length === 1 ? '' : 'es'} (${la!.usedOverride ? 'manual' : strategy.toUpperCase()})${batchWarnCount > 0 ? ` · ${batchWarnCount} warning${batchWarnCount === 1 ? '' : 's'}` : ''}`
                : '';
              const whOptions = item.available_warehouses || [];
              const lineWhIds = lineWarehouseIds(item);
              const selectedWhs = lineWhIds
                ? lineWhIds.map(id => whOptions.find(w => w.warehouse_id === id)).filter((w): w is NonNullable<typeof w> => !!w)
                : [];
              // A product stocked in one warehouse offers no choice, so the
              // picker would be a dead control occupying a full row.
              const multiWarehouse = whOptions.length > 1;
              const activeWarehouseName = lineWhIds
                ? selectedWhs.map(w => w.warehouse_name).join(' + ')
                : whOptions.find(w => w.warehouse_id === item.warehouse_id)?.warehouse_name
                  || warehouses.find(w => w.id === item.warehouse_id)?.name
                  || '';
              // The chosen warehouse(s) must hold what the line needs; when
              // they do not, the picker carries a warning count.
              const activeWhStock = lineWhIds
                ? selectedWhs.reduce((s, w) => s + (w.stock || 0), 0)
                : whOptions.find(w => w.warehouse_id === item.warehouse_id)?.stock;
              const warehouseShort = activeWhStock != null ? Math.max(0, item.base_quantity - activeWhStock) : 0;
              const warehouseWarnCount = warehouseShort > 1e-9 ? 1 : 0;
              const warehouseButtonTitle = lineWhIds
                ? `Warehouses — ${selectedWhs.map(w => `${w.warehouse_name} ${fmtQty(w.stock)}`).join(' · ')}${warehouseWarnCount > 0 ? ` · short ${fmtQty(warehouseShort)}` : ''}`
                : `Warehouse — ${activeWarehouseName || 'not set'}${warehouseWarnCount > 0 ? ` · short ${fmtQty(warehouseShort)}` : ''}`;
              return (
            <div
              key={`${item.id}-${item.selected_unit?.id || 'default'}`}
              id={`pos-line-${CSS.escape(liKey)}`}
              draggable
              onDragStart={() => setDraggedItem(index)}
              onDragOver={e => { e.preventDefault(); setDragOverItem(index); }}
              onDrop={() => { if (draggedItem !== null && draggedItem !== index) reorderCart(draggedItem, index); setDraggedItem(null); setDragOverItem(null); }}
              onDragEnd={() => { setDraggedItem(null); setDragOverItem(null); }}
              className={`bg-muted/30 rounded-lg px-2.5 py-1.5 transition-all ${draggedItem === index ? 'opacity-40' : ''} ${dragOverItem === index && draggedItem !== index ? 'border-2 border-blue-400' : ''} ${activeCartLine === index ? 'ring-2 ring-blue-500/70 bg-blue-50/60' : ''} lg:cursor-grab lg:active:cursor-grabbing`}
            >
              <div className="flex items-center gap-1.5">
                {/* Reorder is desktop-only: HTML5 drag events never fire on
                    touch, so the handle is hidden rather than lying. */}
                <span className="hidden lg:inline text-muted-foreground/40 text-xs select-none shrink-0">⠿</span>
                <button
                  onClick={() => removeCartLine(item)}
                  aria-label={`Remove ${item.name} from the cart`}
                  title="Remove line"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-red-50 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
                <ProductNameTooltip
                  name={item.name}
                  sku={item.sku}
                  className="flex-1 min-w-0 text-sm font-semibold text-foreground leading-tight line-clamp-2 cursor-default"
                />
                <span className="text-sm font-bold text-blue-600 shrink-0 whitespace-nowrap">{formatCurrency(lineTotal)}</span>
                {(item.discount_percent || 0) > 0 && (
                  <span className="text-[11px] font-semibold text-green-600 bg-green-50 border border-green-200 rounded px-1 py-px shrink-0 whitespace-nowrap">
                    −{fmtQty(item.discount_percent)}%
                  </span>
                )}
              </div>
              <div className="flex items-end gap-1 min-[400px]:gap-1.5 sm:gap-2 mt-1 pl-4 min-[400px]:pl-5 sm:pl-6">
                <div className="flex flex-col">
                  <label htmlFor={`pos-price-${CSS.escape(liKey)}`} className="text-xs font-medium text-muted-foreground leading-none mb-0.5">Price</label>
                  <input
                    id={`pos-price-${CSS.escape(liKey)}`}
                    type="number"
                    min="0"
                    step="0.01"
                    value={item.unit_price}
                    onChange={e => updateCartPrice(item.id, item.selected_unit?.id, parseFloat(e.target.value) || 0)}
                    onClick={e => e.stopPropagation()}
                    className={`w-14 min-[400px]:w-16 sm:w-20 min-w-0 text-sm border border-border rounded px-1.5 py-1 focus:outline-none focus:border-blue-400 text-right tabular-nums bg-white ${fieldSel('price') ? 'ring-2 ring-blue-500/70' : ''}`}
                  />
                </div>
                {item.selected_unit && <span className="shrink-0 hidden min-[360px]:inline text-[10px] sm:text-xs text-muted-foreground pb-1.5">/{item.selected_unit.unit_short || item.selected_unit.unit_name}</span>}
                <div className="flex flex-col">
                  <label htmlFor={`pos-disc-${CSS.escape(liKey)}`} className="text-xs font-medium text-muted-foreground leading-none mb-0.5">Disc %</label>
                  <input
                    id={`pos-disc-${CSS.escape(liKey)}`}
                    type="number"
                    min="0"
                    max="100"
                    step="0.5"
                    value={item.discount_percent || 0}
                    onChange={e => updateCartItemDiscount(item.id, item.selected_unit?.id, parseFloat(e.target.value) || 0)}
                    onClick={e => e.stopPropagation()}
                    className={`w-12 min-[400px]:w-14 sm:w-16 min-w-0 text-sm border border-amber-300 rounded px-1.5 py-1 focus:outline-none focus:border-amber-400 text-right tabular-nums bg-amber-50/30 ${fieldSel('disc') ? 'ring-2 ring-blue-500/70' : ''}`}
                    placeholder="0"
                  />
                </div>
                {(item.discount_percent || 0) > 0 && (
                  /* Effective per-unit rate after the discount, sitting right
                     after the box that produced it. Hidden on very narrow
                     carts where the row has no room left. */
                  <div
                    className="hidden min-[480px]:flex flex-col shrink-0 border-l border-border/70 pl-1.5 ml-0.5"
                    title={`${formatCurrency(item.unit_price)} − ${fmtQty(item.discount_percent)}% = ${formatCurrency(netUnitPrice)} per ${lineUnitLabel}`}
                  >
                    <span className="text-xs font-medium text-muted-foreground leading-none mb-0.5 whitespace-nowrap">Net</span>
                    <span className="h-[30px] flex items-center text-[13px] font-semibold text-green-600 tabular-nums whitespace-nowrap">
                      {formatCurrency(netUnitPrice)}
                    </span>
                  </div>
                )}
                {multiWarehouse && (
                  /* Warehouse choice lives in the inputs row as an icon too —
                     same treatment as the batch button, so a line never spends
                     a row on a picker. */
                  <div className="flex flex-col ml-auto">
                    <span className="text-xs font-medium text-muted-foreground leading-none mb-0.5 text-right">WH</span>
                    <button
                      id={`pos-wh-${CSS.escape(liKey)}`}
                      onClick={e => { e.stopPropagation(); setPickingWarehouseLine(liKey); }}
                      title={warehouseButtonTitle}
                      aria-label={warehouseButtonTitle}
                      className={`relative h-8 w-8 shrink-0 rounded-md border border-emerald-200 bg-emerald-50/60 text-emerald-700 hover:bg-emerald-100 transition flex items-center justify-center ${fieldSel('wh') ? 'ring-2 ring-blue-500/70' : ''}`}
                    >
                      <Warehouse className="w-3.5 h-3.5" />
                      {warehouseWarnCount > 0 && (
                        <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center leading-none shadow-sm">
                          {warehouseWarnCount}
                        </span>
                      )}
                    </button>
                  </div>
                )}
                {hasBatchButton && (
                  /* Batch allocation lives in the inputs row: a Layers button
                     that carries the warning count, so a line never spends a
                     separate row on batch metadata. */
                  <div className={`flex flex-col ${multiWarehouse ? '' : 'ml-auto'}`}>
                    <span className="text-xs font-medium text-muted-foreground leading-none mb-0.5 text-right">Batch</span>
                    <button
                      id={`pos-batch-${CSS.escape(liKey)}`}
                      onClick={e => { e.stopPropagation(); setViewingBatchLine(liKey); }}
                      title={batchButtonTitle}
                      aria-label={batchButtonTitle}
                      className={`relative h-8 w-8 shrink-0 rounded-md border transition flex items-center justify-center ${
                        la.usedOverride
                          ? 'border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100'
                          : 'border-blue-200 bg-blue-50/60 text-blue-700 hover:bg-blue-100'
                      } ${fieldSel('batch') ? 'ring-2 ring-blue-500/70' : ''}`}
                    >
                      <Layers className="w-3.5 h-3.5" />
                      {batchWarnCount > 0 && (
                        <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center leading-none shadow-sm">
                          {batchWarnCount}
                        </span>
                      )}
                    </button>
                  </div>
                )}
                <div className={`flex flex-col ${multiWarehouse || hasBatchButton ? '' : 'ml-auto'}`}>
                  <label htmlFor={`pos-qty-${CSS.escape(liKey)}`} className="text-xs font-medium text-muted-foreground leading-none mb-0.5 text-right">Qty</label>
                  <input
                    id={`pos-qty-${CSS.escape(liKey)}`}
                    type="number"
                    min="0"
                    step={allowDecimalFor(item.allow_decimal, item.unit) ? '0.01' : '1'}
                    value={item.quantity}
                    onChange={e => updateCartQuantity(item.id, item.selected_unit?.id, parseFloat(e.target.value) || 0)}
                    onClick={e => e.stopPropagation()}
                    title={item.quantity > 0 ? undefined : 'Quantity 0 — this line stays in the cart but is not charged'}
                    className={`w-14 min-[400px]:w-16 sm:w-20 min-w-0 text-sm font-bold border border-border rounded px-1.5 py-1 text-right tabular-nums focus:outline-none focus:border-blue-400 bg-white ${fieldSel('qty') ? 'ring-2 ring-blue-500/70' : item.quantity > 0 ? '' : 'ring-2 ring-amber-400'} ${item.quantity > 0 ? '' : 'text-amber-700'}`}
                  />
                </div>
              </div>
            </div>
              );
            })
          ) : (
            /* Cost Price History preview tab */
            <div className="space-y-2">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-2.5 text-[11px] text-blue-800">
                Cost price snapshot that will be recorded when this sale is completed.
              </div>
              <div className="border border-border rounded-lg overflow-hidden">
                <table className="w-full">
                  <thead className="bg-muted/40">
                    <tr>
                      <th className="text-left text-xs font-semibold text-muted-foreground px-2 py-1.5">Product</th>
                      <th className="text-right text-xs font-semibold text-muted-foreground px-2 py-1.5">Qty</th>
                      <th className="text-right text-xs font-semibold text-muted-foreground px-2 py-1.5">Cost/Unit</th>
                      <th className="text-right text-xs font-semibold text-muted-foreground px-2 py-1.5">Total Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {cart.map((item, i) => {
                      const costPerUnit = item.cost_price || 0;
                      const totalCost = costPerUnit * item.quantity;
                      return (
                        <tr key={i} className="hover:bg-muted/20">
                          <td className="px-2 py-1.5">
                            <ProductNameTooltip
                              name={item.name}
                              sku={item.sku}
                              className="text-sm font-medium text-foreground break-words max-w-[160px] cursor-default"
                            />
                            <p className="text-xs text-muted-foreground">{item.selected_unit?.unit_name || normalizeUnitLabel(item.unit)}</p>
                          </td>
                          <td className="px-2 py-1.5 text-right text-sm text-foreground">{item.quantity}</td>
                          <td className="px-2 py-1.5 text-right text-sm text-foreground">{formatCurrency(costPerUnit)}</td>
                          <td className="px-2 py-1.5 text-right text-sm font-semibold text-foreground">{formatCurrency(totalCost)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-muted/30">
                    <tr>
                      <td colSpan={3} className="px-2 py-1.5 text-right text-xs font-semibold text-muted-foreground">Total Cost:</td>
                      <td className="px-2 py-1.5 text-right text-sm font-bold text-foreground">
                        {formatCurrency(cart.reduce((s, item) => s + (item.cost_price || 0) * item.quantity, 0))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="flex justify-between text-sm pt-1">
                <span className="text-muted-foreground">Selling Total:</span>
                <span className="font-bold text-foreground">{formatCurrency(grandTotal)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Profit (est.):</span>
                <span className="font-bold text-green-600">{formatCurrency(total - cart.reduce((s, item) => s + (item.cost_price || 0) * item.quantity, 0))}</span>
              </div>
            </div>
          )}
          </div>
          {/* Hidden-content cues. Opacity only, so neither edge ever reflows
              the list; inset-x-0 keeps them flush with the scroll gutter. */}
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-white to-transparent transition-opacity duration-150 ${cartScrollEdges.top ? 'opacity-100' : 'opacity-0'}`}
          />
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-white to-transparent transition-opacity duration-150 ${cartScrollEdges.bottom ? 'opacity-100' : 'opacity-0'}`}
          />
        </div>

        {cart.length > 0 && (
          <>
            {renderCartFooter(footerPinned ? 'invisible' : '', true)}
            {footerPinned && createPortal(renderCartFooter('', false), document.body)}
          </>
        )}

        {orderComplete && (
          <div className="absolute inset-0 bg-white flex flex-col items-center justify-center rounded-2xl z-10">
            <CheckCircle2 className="w-16 h-16 text-green-500 mb-3" />
            <h3 className="font-bold text-lg text-foreground">Order Complete!</h3>
            <p className="text-sm text-muted-foreground mt-1">{lastInvoiceNumber}</p>
            <div className="flex items-center gap-2 mt-4">
              {lastReceipt && (
                <button
                  onClick={() => setShowReceipt(true)}
                  className="flex items-center gap-1.5 px-4 py-2 bg-slate-700 hover:bg-slate-800 text-white rounded-lg text-sm font-semibold transition"
                >
                  <Printer className="w-4 h-4" />Print Receipt
                </button>
              )}
              <button
                onClick={() => {
                  if (orderCompleteTimerRef.current) clearTimeout(orderCompleteTimerRef.current);
                  setOrderComplete(false);
                }}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition">New Order</button>
            </div>
          </div>
        )}
      </div>

      {/* Checkout Modal */}
      {showCheckout && (
        <CheckoutModal
          total={grandTotal}
          taxAmount={posVat.taxAmount}
          vatLabel={vatSettings.enabled ? `VAT (${vatSettings.rate}%${vatSettings.mode === 'inclusive' ? ', in prices' : ''})` : ''}
          subtotal={subtotal}
          discount={discount}
          discountAmount={discountAmount}
          extraDiscount={extraDiscount}
          shipping={shipping}
          itemDiscountTotal={itemDiscountTotal}
          cartDiscountAmount={cartDiscountAmount}
          paymentMethod={paymentMethod}
          setPaymentMethod={setPaymentMethod}
          displayMethods={displayMethods}
          paymentMethodIcons={paymentMethodIcons}
          paymentMethodColors={paymentMethodColors}
          amountPaid={amountPaid}
          setAmountPaid={setAmountPaid}
          processing={processing}
          onConfirm={processOrder}
          onClose={() => setShowCheckout(false)}
          storeCreditBalance={storeCreditBalance}
          applyStoreCredit={applyStoreCredit}
          setApplyStoreCredit={setApplyStoreCredit}
          selectedCustomer={selectedCustomer}
          customers={customers}
          cart={cart}
          paymentTerm={paymentTerm}
          setPaymentTerm={setPaymentTerm}
          partialAmount={partialAmount}
          setPartialAmount={setPartialAmount}
          previousDueTotal={previousDueTotal}
          customerOutstanding={customerOutstanding}
          dueCollectInput={dueCollectInput}
          setDueCollectInput={setDueCollectInput}
          collectMode={collectMode}
          setCollectMode={setCollectMode}
          settlement={settlement}
          advanceBalance={advanceBalance}
          isRegisteredCustomer={isRegisteredCustomer}
        />
      )}

      {/* Receipt preview + print — opened from the Order Complete panel.
          Works offline: everything renders from the charge snapshot. */}
      {showReceipt && lastReceipt && (
        <InvoicePreviewModal
          docType="INVOICE"
          docNumber={lastReceipt.number}
          docDate={lastReceipt.date}
          status={lastReceipt.status}
          isOfflinePending={lastReceipt.offline}
          company={{
            name: companySettings?.name || 'Your Company',
            address: companySettings?.address,
            phone: companySettings?.phone,
            email: companySettings?.email,
            logo_url: companySettings?.logo_url,
          }}
          customer={{
            name: lastReceipt.customer?.name || 'Walk In',
            code: lastReceipt.customer?.code,
            phone: lastReceipt.customer?.phone,
            email: lastReceipt.customer?.email,
            address: lastReceipt.customer?.address,
          }}
          items={lastReceipt.items}
          subtotal={lastReceipt.subtotal}
          discountTotal={lastReceipt.items.reduce((s, i) => s + i.quantity * i.unit_price * (i.discount_percent || 0) / 100, 0)}
          cartDiscount={lastReceipt.cartDiscount}
          cartDiscountPercent={lastReceipt.cartDiscountPercent}
          extraDiscount={lastReceipt.extraDiscount}
          taxAmount={lastReceipt.taxAmount}
          taxLabel={vatSettings.enabled ? `VAT (${vatSettings.rate}%)` : 'VAT'}
          shippingAmount={lastReceipt.shipping}
          recalculatedSubtotal={lastReceipt.items.reduce((s, i) => s + (Number(i.subtotal) || 0), 0)}
          totalAmount={lastReceipt.total}
          amountPaid={lastReceipt.paidTotal}
          balanceDue={Math.max(0, lastReceipt.total - lastReceipt.paidTotal)}
          dueCollected={lastReceipt.dueCollected || 0}
          advanceApplied={lastReceipt.advanceApplied || 0}
          customerOutstanding={lastReceipt.dueCollected > 0 ? {
            total: lastReceipt.previousDue,
            invoiceDues: lastReceipt.previousDue,
            previousInvoiceDues: lastReceipt.previousDue,
            thisInvoiceDues: 0,
            manualDues: 0,
            storeCredit: 0,
            advanceBalance: 0,
          } : undefined}
          reference={lastReceipt.reference || undefined}
          payments={lastReceipt.cashPaid > 0 ? [{
            payment_number: '',
            payment_date: lastReceipt.date,
            amount: lastReceipt.cashPaid,
            payment_method: lastReceipt.paymentMethod,
          }] : undefined}
          onClose={() => setShowReceipt(false)}
          printRef={receiptPrintRef}
          showProductLinks={false}
          showPrintOptions={true}
        />
      )}

      {shortfallConfirmOpen && (
        <OversellConfirmDialog
          shortfalls={pendingShortfalls}
          blocked={oversellBlocked}
          onGoBack={() => { setShortfallConfirmOpen(false); setPendingShortfalls([]); setOversellBlocked(false); }}
          onConfirm={() => {
            shortfallConfirmedRef.current = true;
            setShortfallConfirmOpen(false);
            processOrder();
          }}
        />
      )}

      {creditConfirmOpen && pendingCreditCheck && (
        <CreditConfirmDialog
          check={pendingCreditCheck}
          onGoBack={() => { setCreditConfirmOpen(false); setPendingCreditCheck(null); }}
          onConfirm={() => {
            creditConfirmedRef.current = true;
            setCreditConfirmOpen(false);
            setPendingCreditCheck(null);
            processOrder();
          }}
        />
      )}

          {/* Insufficient stock at add-time (spec §6) — configurable partial add */}
      {insufficient && (
        <InsufficientStockDialog
          info={insufficient.info}
          allowPartial={invSettings.allow_partial_add}
          onAddPartial={(partialQty) => {
            performAdd(insufficient.product, insufficient.unit, partialQty, insufficient.targetWarehouseId, insufficient.availableWhs, insufficient.targetWarehouseIds);
            setInsufficient(null);
          }}
          onCancel={() => setInsufficient(null)}
        />
      )}

      {/* Keyboard shortcut cheat-sheet ("?") */}
      {showShortcuts && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40" onClick={() => setShowShortcuts(false)}>
          <div className="bg-white rounded-2xl shadow-xl p-5 w-[340px] text-sm" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-foreground">Keyboard shortcuts</h3>
              <button onClick={() => setShowShortcuts(false)} className="text-muted-foreground hover:text-foreground transition" title="Close (Esc)">
                <X className="w-4 h-4" />
              </button>
            </div>
            <ul className="space-y-2">
              {[
                ['/', 'Focus product search'],
                ['Enter', 'Add exact SKU/barcode match'],
                ['Shift+N', 'New sale (clear cart)'],
                ['Shift+P', 'Checkout (Pay)'],
                ['Ctrl+Enter', 'Checkout (Pay)'],
                ['↑ / ↓', 'Select cart line'],
                ['Shift+← / →', 'Move within line options'],
                ['Enter', 'Select option'],
                ['← / →', 'Adjust line qty'],
                ['Esc', 'Remove selected line'],
                ['Arrows (checkout)', 'Choose payment option'],
                ['Enter (checkout)', 'Next → then Charge'],
                ['Shift+L', 'Open sale details'],
                ['Esc', 'Close / step back'],
                ['?', 'This cheat-sheet'],
              ].map(([k, d]) => (
                <li key={k} className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{d}</span>
                  <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-foreground whitespace-nowrap">{k}</kbd>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Batch allocation viewer (read-only; spec §7–§8) */}
      {viewingBatchLine && (() => {
        const item = cart.find(c => lineIdOf(c) === viewingBatchLine);
        if (!item) return null;
        const la = lineAllocation(item);
        if (!la) return null;
        // Name what the line draws from: the selected warehouses (multi) or
        // the single consumption warehouse.
        const lineWhIds = lineWarehouseIds(item);
        const whName = lineWhIds
          ? lineWhIds.map(id =>
              (item.available_warehouses || []).find(w => w.warehouse_id === id)?.warehouse_name
              || warehouses.find(w => w.id === id)?.name
              || 'Unknown'
            ).join(' + ')
          : (() => {
              const allocWh = resolveWarehouse({ warehouseId: item.warehouse_id }, defaultWarehouseId);
              return (item.available_warehouses || []).find(w => w.warehouse_id === allocWh)?.warehouse_name
                || warehouses.find(w => w.id === allocWh)?.name
                || 'Not assigned';
            })();
        const whNameMap = Object.fromEntries((item.available_warehouses || []).map(w => [w.warehouse_id, w.warehouse_name]));
        return (
          <BatchAllocationViewer
            line={{
              productName: item.name,
              sku: item.sku,
              unitLabel: item.selected_unit ? (item.selected_unit.unit_short || item.selected_unit.unit_name) : undefined,
              warehouseName: whName,
              lineQty: item.base_quantity,
              allocatedQty: la.allocatedQty,
              shortfall: la.shortfall,
              usedOverride: la.usedOverride,
              overrideInvalid: la.overrideInvalid,
              strategy,
              allocations: la.allocations,
              warehouseNames: lineWhIds ? whNameMap : undefined,
              conversionFactor: item.selected_unit?.conversion_factor ?? 1,
            }}
            onEdit={lineWhIds ? undefined : () => { setEditingAllocLine(viewingBatchLine); setViewingBatchLine(null); }}
            onClose={() => setViewingBatchLine(null)}
          />
        );
      })()}

      {/* Warehouse picker (spec §12) — multi-select so a line can draw from
          every stocked warehouse instead of one */}
      {pickingWarehouseLine && (() => {
        const item = cart.find(c => lineIdOf(c) === pickingWarehouseLine);
        if (!item) return null;
        return (
          <WarehouseSelectModal
            productName={item.name}
            unitLabel={item.selected_unit ? (item.selected_unit.unit_short || item.selected_unit.unit_name) : undefined}
            needBaseQty={item.base_quantity}
            conversionFactor={item.selected_unit?.conversion_factor ?? 1}
            options={(item.available_warehouses || []).map(w => ({
              warehouse_id: w.warehouse_id,
              warehouse_name: w.warehouse_name,
              stock: w.stock,
            }))}
            multi
            selectedIds={lineWarehouseIds(item) || (item.warehouse_id ? [item.warehouse_id] : [])}
            onSelect={(wid) => {
              setWarehousesForLine(pickingWarehouseLine, [wid]);
              setPickingWarehouseLine(null);
            }}
            onDone={(ids) => {
              setWarehousesForLine(pickingWarehouseLine, ids);
              setPickingWarehouseLine(null);
            }}
            onClose={() => setPickingWarehouseLine(null)}
          />
        );
      })()}

      {/* Manual batch allocation override (spec §9) */}
      {editingAllocLine && (() => {
        const item = cart.find(c => lineIdOf(c) === editingAllocLine);
        if (!item || !allocation) return null;
        const la = lineAllocation(item);
        return (
          <BatchAllocationEditor
            productName={item.name}
            lineQty={item.base_quantity}
            unitLabel={item.selected_unit ? (item.selected_unit.unit_short || item.selected_unit.unit_name) : undefined}
            batches={editorBatchesFor(item)}
            autoAllocations={autoAllocMapFor(item)}
            initialOverride={la?.usedOverride ? Object.fromEntries(la.allocations.map(a => [a.batch.id, a.qty])) : null}
            strategy={strategy}
            onSave={(ov) => saveAllocationOverride(item, ov)}
            onUseAuto={() => {
              setCart(prev => prev.map(c => (lineIdOf(c) === editingAllocLine ? { ...c, allocOverride: null } : c)));
              setEditingAllocLine(null);
            }}
            onClose={() => setEditingAllocLine(null)}
          />
        );
      })()}

      {showScanner && (
        <BarcodeScannerModal
          onDetected={async (code) => {
            setShowScanner(false);
            const product = await findProductByCode(code);
            if (product) {
              handleProductClick(product);
              toast({ title: 'Product found', description: product.name });
            } else {
              toast({ title: 'Not found', description: `No product with SKU or barcode ${code}`, variant: 'destructive' });
            }
          }}
          onClose={() => setShowScanner(false)}
        />
      )}

      {showAddCustomer && (
        <AddCustomerModal
          onClose={() => setShowAddCustomer(false)}
          onSaved={(id, row) => {
            // Patch the row into the local list + cache directly — a
            // cachedQuery reload could serve a pre-insert snapshot.
            if (row) {
              setCustomers(prev => [row, ...prev]);
              void mutateCache<any[]>(CACHE_KEYS.customers, list => [row, ...(list || [])]);
            } else {
              loadCustomers();
            }
            setSelectedCustomer(id);
          }}
        />
      )}

      {unitSelectorProduct && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <h3 className="font-bold text-sm">{unitSelectorProduct.name}</h3>
                <p className="text-xs text-muted-foreground">Select unit for this sale</p>
              </div>
              <button onClick={() => setUnitSelectorProduct(null)} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-4 space-y-2">
              {/* Enter quantity → Add to Cart (spec §17); allocation is
                  automatic afterwards — no batch popup */}
              {(() => {
                const info = getProductAvailable(unitSelectorProduct);
                return (
                  <p className="text-[11px] text-muted-foreground">
                    Available: <span className="font-semibold text-foreground">{fmtQty(info.available)}</span> base units
                    {info.batches > 0 ? ` · ${info.batches} batch${info.batches === 1 ? '' : 'es'} · ${strategy.toUpperCase()}` : ''}
                  </p>
                );
              })()}
              <div className="flex items-center justify-between gap-2 pb-2 border-b border-border">
                <span className="text-xs font-semibold text-muted-foreground">QUANTITY</span>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setUnitSelectorQty(q => String(Math.max(0, (parseFloat(q) || 0) - 1)))}
                    className="w-8 h-8 border border-border rounded-lg text-sm font-bold text-muted-foreground hover:bg-muted transition"
                  >−</button>
                  <input
                    type="number"
                    min="0"
                    step={allowDecimalFor(unitSelectorProduct.allow_decimal, unitSelectorProduct.unit) ? '0.01' : '1'}
                    value={unitSelectorQty}
                    onChange={e => setUnitSelectorQty(e.target.value)}
                    className="w-24 text-right tabular-nums text-sm font-bold border border-border rounded-lg px-1 py-1.5 focus:outline-none focus:border-blue-400 bg-white"
                  />
                  <button
                    onClick={() => setUnitSelectorQty(q => String((parseFloat(q) || 0) + 1))}
                    className="w-8 h-8 border border-border rounded-lg text-sm font-bold text-muted-foreground hover:bg-muted transition"
                  >+</button>
                </div>
              </div>
              {unitSelectorProduct.units?.filter(u => u.is_active).map(unit => (
                <button
                  key={unit.id}
                  onClick={() => addToCart(unitSelectorProduct, unit, parseFloat(unitSelectorQty) || 1)}
                  className="w-full flex items-center justify-between p-3 border border-border rounded-xl hover:border-blue-400 hover:bg-blue-50/50 transition"
                >
                  <div className="text-left">
                    <p className="text-sm font-semibold">{unit.unit_name} {unit.unit_short && <span className="text-muted-foreground font-normal">({unit.unit_short})</span>}</p>
                    <p className="text-xs text-muted-foreground">
                      1 {unit.unit_name} = {unit.conversion_factor} {unitSelectorProduct.base_unit || 'base units'}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-blue-600">{formatCurrency(unit.price)}</p>
                    <p className="text-[10px] text-muted-foreground">per {unit.unit_short || unit.unit_name}</p>
                  </div>
                </button>
              ))}
              {(!unitSelectorProduct.units || unitSelectorProduct.units.filter(u => u.is_active).length === 0) && (
                <button
                  onClick={() => addToCart(unitSelectorProduct, undefined, parseFloat(unitSelectorQty) || 1)}
                  className="w-full flex items-center justify-between p-3 border border-border rounded-xl hover:border-blue-400 hover:bg-blue-50/50 transition"
                >
                  <p className="text-sm font-semibold">{unitSelectorProduct.unit || 'Piece'}</p>
                  <p className="text-sm font-bold text-blue-600">{formatCurrency(unitSelectorProduct.sale_price)}</p>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Image Change Modal */}
      {showImageModal && imageModalProduct && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[110] p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <h3 className="font-bold text-sm flex items-center gap-2"><ImagePlus className="w-4 h-4" /> Product Image</h3>
                <p className="text-xs text-muted-foreground break-words">{imageModalProduct.name}</p>
              </div>
              <button onClick={() => setShowImageModal(false)} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-5 space-y-4">
              {/* Current image preview */}
              <div className="w-full h-40 bg-muted rounded-xl overflow-hidden flex items-center justify-center">
                {imageModalUrl ? (
                  <img src={imageModalUrl} alt="Preview" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                ) : (
                  <div className="flex flex-col items-center text-muted-foreground">
                    <Package className="w-12 h-12 text-muted-foreground/30 mb-2" />
                    <p className="text-xs">No image set</p>
                  </div>
                )}
              </div>

              {/* Image URL input */}
              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-1.5">IMAGE URL</label>
                <input
                  type="text"
                  value={imageModalUrl}
                  onChange={e => setImageModalUrl(e.target.value)}
                  placeholder="https://images.pexels.com/photos/..."
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
                <p className="text-[11px] text-muted-foreground mt-1">Paste an image URL (e.g. from Pexels)</p>
              </div>

              {/* Toggle: set as default for all products */}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={imageModalIsDefault}
                  onChange={e => setImageModalIsDefault(e.target.checked)}
                  className="w-4 h-4 rounded border-border"
                />
                <span className="text-sm text-foreground">Set as default image for all products without images</span>
              </label>

              <div className="flex gap-2 pt-2">
                <button onClick={() => setShowImageModal(false)} className="flex-1 px-4 py-2 border border-border rounded-lg text-sm font-medium hover:bg-muted transition">Cancel</button>
                <button
                  onClick={async () => {
                    if (imageModalIsDefault) {
                      await supabase.from('app_settings').upsert({ setting_key: 'product_defaults', setting_value: { default_image_url: imageModalUrl } });
                      setDefaultProductImage(imageModalUrl);
                    } else if (imageModalProduct) {
                      await supabase.from('products').update({ image_url: imageModalUrl || null }).eq('id', imageModalProduct.id);
                      setProducts(prev => prev.map(p => p.id === imageModalProduct.id ? { ...p, image_url: imageModalUrl || undefined } : p));
                    }
                    setShowImageModal(false);
                    toast({ title: imageModalIsDefault ? 'Default image updated' : 'Product image updated' });
                  }}
                  className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition"
                >
                  Save Image
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AddCustomerModal({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string, row?: any) => void }) {
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
    if (!form.name.trim()) { setError('Customer name is required'); return; }
    setSaving(true);
    setError('');

    const code = `CUST-${Date.now().toString().slice(-6)}`;
    const data = {
      code,
      name: form.name.trim(),
      phone: form.phone || null,
      email: form.email || null,
      address: form.address || null,
      type: form.type,
      country: 'Bangladesh',
      is_active: true,
      credit_limit: 0,
      credit_days: 0,
      loyalty_points: 0,
      discount_percent: 0,
    };

    // Offline: queue with a client-generated id so the POS can sell to this
    // customer immediately — the queued invoice references the same id and
    // syncs after the customer row lands (queue is strictly ordered).
    if (!networkMonitor.getState().online) {
      const id = crypto.randomUUID();
      const offlineRow = {
        id,
        ...data,
        outstanding_balance: 0,
        total_purchases: 0,
      };
      try {
        await enqueueOp('customer.create', { id, data }, `New customer — ${form.name.trim()}`);
      } catch (err: any) {
        setError(err?.message || 'Offline storage error');
        setSaving(false);
        return;
      }
      toast({ title: 'Customer queued offline', description: `${form.name.trim()} will sync with your next order.` });
      onSaved(id, offlineRow);
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
    onSaved(inserted.id, { id: inserted.id, ...data, outstanding_balance: 0, total_purchases: 0 });
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-bold flex items-center gap-2"><UserPlus className="w-4 h-4" />Add New Customer</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSave} className="p-4 space-y-3">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}
          <div>
            <label className="block text-xs font-medium mb-1">Customer Name *</label>
            <input
              required
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
                onChange={e => setForm({ ...form, type: e.target.value as any })}
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
            <button type="submit" disabled={saving} className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-50">{saving ? 'Saving...' : 'Add Customer'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** What a "Previous dues first" charge will do, line by line. */
function DuesSplitPreview({ settlement, total }: { settlement: PosSettlement; total: number }) {
  const leftDue = Math.max(0, round2(total - settlement.invoicePaidTotal));
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-1 text-xs">
      {settlement.duesAlloc.length > 0 ? (
        <>
          <p className="text-[11px] font-semibold text-amber-800">Clearing old dues (oldest first)</p>
          {settlement.duesAlloc.map(a => (
            <div key={a.invoice_id} className="flex justify-between text-[11px] text-amber-700">
              <span>{a.invoice_number}</span>
              <span>-{formatCurrency(a.amount)}</span>
            </div>
          ))}
        </>
      ) : (
        <p className="text-[11px] text-muted-foreground">No old dues are cleared with this amount.</p>
      )}
      <div className="flex justify-between pt-1 border-t border-amber-200">
        <span className="text-muted-foreground">This bill paid</span>
        <span className="font-medium">{formatCurrency(settlement.cashToBill)}</span>
      </div>
      <div className="flex justify-between text-blue-600">
        <span>Left due on this bill</span>
        <span className="font-medium">{formatCurrency(leftDue)}</span>
      </div>
      {settlement.change > 0 && (
        <div className="flex justify-between text-green-600">
          <span>Change</span>
          <span className="font-medium">{formatCurrency(settlement.change)}</span>
        </div>
      )}
    </div>
  );
}

/** What an "Advance balance first" charge will do, line by line. */
function AdvanceSplitPreview({ settlement, total, advanceBalance }: { settlement: PosSettlement; total: number; advanceBalance: number }) {
  const leftDue = Math.max(0, round2(total - settlement.invoicePaidTotal));
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 space-y-1 text-xs">
      <p className="text-[11px] font-semibold text-blue-800">
        Advance balance available: {formatCurrency(advanceBalance)}
      </p>
      {settlement.advanceAlloc.length > 0 ? (
        settlement.advanceAlloc.map(a => (
          <div key={a.advance_id} className="flex justify-between text-[11px] text-blue-700">
            <span>{a.advance_number}</span>
            <span>-{formatCurrency(a.amount)}</span>
          </div>
        ))
      ) : (
        <p className="text-[11px] text-muted-foreground">No advance balance is used for this bill.</p>
      )}
      <div className="flex justify-between text-blue-700 pt-1 border-t border-blue-200">
        <span>Advance applied</span>
        <span className="font-medium">{formatCurrency(settlement.advanceApplied)}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-muted-foreground">Cash for this bill</span>
        <span className="font-medium">{formatCurrency(settlement.cashToBill)}</span>
      </div>
      <div className="flex justify-between text-blue-600">
        <span>Left due on this bill</span>
        <span className="font-medium">{formatCurrency(leftDue)}</span>
      </div>
      {settlement.change > 0 && (
        <div className="flex justify-between text-green-600">
          <span>Change</span>
          <span className="font-medium">{formatCurrency(settlement.change)}</span>
        </div>
      )}
    </div>
  );
}

function CheckoutModal({
  total, taxAmount, vatLabel, subtotal, discount, discountAmount, extraDiscount, shipping, itemDiscountTotal, cartDiscountAmount, paymentMethod, setPaymentMethod,
  displayMethods, paymentMethodIcons, paymentMethodColors,
  amountPaid, setAmountPaid, processing, onConfirm, onClose,
  storeCreditBalance, applyStoreCredit, setApplyStoreCredit, selectedCustomer, customers, cart,
  paymentTerm, setPaymentTerm, partialAmount, setPartialAmount,
  previousDueTotal = 0, customerOutstanding = [], dueCollectInput = '', setDueCollectInput = () => {},
  collectMode = 'cash', setCollectMode = () => {}, settlement, advanceBalance = 0, isRegisteredCustomer = false,
}: {
  total: number; taxAmount: number; vatLabel: string; subtotal: number; discount: number; discountAmount: number; extraDiscount: number; shipping: number; itemDiscountTotal: number; cartDiscountAmount: number;
  paymentMethod: string; setPaymentMethod: (m: string) => void;
  displayMethods: any[]; paymentMethodIcons: Record<string, any>; paymentMethodColors: Record<string, string>;
  amountPaid: string; setAmountPaid: (v: string) => void;
  processing: boolean; onConfirm: () => void; onClose: () => void;
  storeCreditBalance: number; applyStoreCredit: boolean; setApplyStoreCredit: (v: boolean) => void;
  selectedCustomer: any; customers: any[]; cart: any[];
  paymentTerm: string; setPaymentTerm: (v: any) => void;
  partialAmount: string; setPartialAmount: (v: string) => void;
  previousDueTotal?: number;
  customerOutstanding?: { invoice_id: string; invoice_number: string; balance_due: number }[];
  dueCollectInput?: string; setDueCollectInput?: (v: string) => void;
  /** where the money comes from / goes to — see buildPosSettlement */
  collectMode?: PosCollectMode; setCollectMode?: (m: PosCollectMode) => void;
  settlement: PosSettlement;
  advanceBalance?: number; isRegisteredCustomer?: boolean;
}) {
  const [step, setStep] = useState<'method' | 'confirm'>('method');
  const paid = parseFloat(amountPaid) || 0;
  const change = paid - total;
  const totalCost = cart.reduce((s, item) => s + (item.cost_price || 0) * item.quantity, 0);
  const profit = total - totalCost;
  const customerName = selectedCustomer ? (customers.find(c => c.id === selectedCustomer)?.name || 'Walk-in Customer') : 'Walk-in Customer';
  const partialNum = parseFloat(partialAmount) || 0;
  const isWalkIn = !selectedCustomer || selectedCustomer === '00000000-0000-0000-0000-000000000001';
  // The whole split (dues cleared, advance applied, cash to this bill, change)
  // comes from the parent's settlement, so this preview is exactly what the
  // charge will write. Works offline too — dues and advance wallets come from
  // the replica and the queued work replays on reconnect.
  const dueCollectNum = settlement.duesCleared;
  const showDueCollect = settlement.mode === 'cash' && paymentTerm === 'full' && !isWalkIn && previousDueTotal > 0;
  const dueAllocPreview = settlement.duesAlloc;
  const mode = settlement.mode;
  // Tendered change after reserving the due collection (cash mode) — the other
  // modes already carry their own change in the settlement.
  const effectiveChange = mode === 'cash' ? change - (showDueCollect ? dueCollectNum : 0) : settlement.change;
  const appliesToAccount = isRegisteredCustomer && !isWalkIn;
  // Cash the customer still has to hand over in the two account modes.
  const accountModeNeeds = mode === 'dues_first'
    ? Math.max(0, round2(settlement.billNeeds + previousDueTotal))
    : Math.max(0, round2(settlement.billNeeds - settlement.advanceApplied));

  // The visible single-choice buttons in tab order: Collect From → Payment
  // Terms → Payment Method. Arrows walk this list with selection following
  // the cursor, so no separate highlight state is needed — the existing
  // selected styling is the highlight.
  const choices: { key: string; active: boolean; disabled?: boolean; select: () => void }[] = [];
  if (appliesToAccount) {
    choices.push(
      { key: 'collect-cash', active: collectMode === 'cash', select: () => setCollectMode('cash') },
      { key: 'collect-dues', active: collectMode === 'dues_first', disabled: previousDueTotal <= 0, select: () => setCollectMode('dues_first') },
      { key: 'collect-advance', active: collectMode === 'advance_first', disabled: advanceBalance <= 0, select: () => setCollectMode('advance_first') },
    );
  }
  if (mode === 'cash') {
    choices.push(
      { key: 'term-full', active: paymentTerm === 'full', select: () => setPaymentTerm('full') },
      { key: 'term-partial', active: paymentTerm === 'partial', disabled: isWalkIn, select: () => setPaymentTerm('partial') },
      { key: 'term-credit', active: paymentTerm === 'credit', disabled: isWalkIn, select: () => setPaymentTerm('credit') },
    );
  }
  if (mode !== 'cash' || paymentTerm !== 'credit') {
    displayMethods.forEach(m => choices.push({ key: `method-${m.code}`, active: paymentMethod === m.code, select: () => setPaymentMethod(m.code) }));
  }

  // Re-subscribed every render (no deps) so the handler always closes over
  // the current choices and step — the modal re-renders on every keystroke.
  useEffect(() => {
    const isEditable = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        // A focused button/select keeps native activation — tabbing to Back
        // and hitting Enter must go back, not charge.
        const t = e.target;
        if (t instanceof HTMLElement && (t.tagName === 'BUTTON' || t.tagName === 'SELECT')) return;
        e.preventDefault();
        if (processing) return;
        if (step === 'method') {
          // Same gate as the Next button's disabled state.
          if (paymentMethod || paymentTerm === 'credit') setStep('confirm');
        } else {
          onConfirm();
        }
        return;
      }
      if (step !== 'method' || !e.key.startsWith('Arrow')) return;
      // Inside an input the arrows keep native caret/stepper behavior.
      if (isEditable(e.target)) return;
      e.preventDefault();
      const enabled = choices.filter(c => !c.disabled);
      if (enabled.length === 0) return;
      const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
      const cur = enabled.findIndex(c => c.active);
      // Nothing selected yet: ↓/→ enters at the top, ↑/← at the bottom;
      // otherwise move with wrap-around, skipping disabled options.
      const next = cur === -1
        ? (dir === 1 ? 0 : enabled.length - 1)
        : (cur + dir + enabled.length) % enabled.length;
      enabled[next].select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[110] p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 className="text-base font-bold flex items-center gap-2">
            {step === 'method' ? <><CreditCard className="w-4 h-4" /> Select Payment Method</> : <><Receipt className="w-4 h-4" /> Confirm Charge</>}
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 overflow-y-auto">
          {/* Order summary */}
          <div className="bg-muted/30 rounded-xl p-3 space-y-1.5 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="font-medium">{formatCurrency(subtotal + itemDiscountTotal)}</span></div>
            {itemDiscountTotal > 0 && (
              <div className="flex justify-between text-amber-600"><span>Item Discounts</span><span>-{formatCurrency(itemDiscountTotal)}</span></div>
            )}
            {cartDiscountAmount > 0 && (
              <div className="flex justify-between text-red-600"><span>Cart Discount ({discount}%)</span><span>-{formatCurrency(cartDiscountAmount)}</span></div>
            )}
            {extraDiscount > 0 && (
              <div className="flex justify-between text-red-600"><span>Extra Discount</span><span>-{formatCurrency(extraDiscount)}</span></div>
            )}
            {shipping > 0 && (
              <div className="flex justify-between text-blue-700"><span>Shipping /Service Fee</span><span>+{formatCurrency(shipping)}</span></div>
            )}
            {taxAmount > 0 && vatLabel && (
              <div className="flex justify-between text-blue-700"><span>{vatLabel}</span><span>+{formatCurrency(taxAmount)}</span></div>
            )}
            <div className="flex justify-between text-base font-bold pt-1 border-t border-border"><span>Total Due</span><span className="text-blue-600">{formatCurrency(total)}</span></div>
          </div>

          {step === 'method' ? (
            <>
              {/* Collect From — where the money comes from / goes to. Registered
                  customers only: a walk-in has no account to charge or clear. */}
              {appliesToAccount && (
                <div>
                  <label className="block text-xs font-semibold text-muted-foreground mb-2">COLLECT FROM</label>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() => setCollectMode('cash')}
                      className={`flex flex-col items-center gap-1 px-2 py-2.5 rounded-xl border-2 text-[11px] font-medium transition ${mode === 'cash' ? 'text-green-700 bg-green-50 border-green-600 ring-2 ring-green-500/10' : 'border-border text-muted-foreground hover:border-green-200 hover:bg-green-50/30'}`}
                    >
                      <Banknote className="w-4 h-4" /> Cash
                      <span className="text-[10px] text-muted-foreground">Pay this bill</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setCollectMode('dues_first')}
                      disabled={previousDueTotal <= 0}
                      className={`flex flex-col items-center gap-1 px-2 py-2.5 rounded-xl border-2 text-[11px] font-medium transition ${mode === 'dues_first' ? 'text-amber-700 bg-amber-50 border-amber-600 ring-2 ring-amber-500/10' : 'border-border text-muted-foreground hover:border-amber-200 hover:bg-amber-50/30'} ${previousDueTotal <= 0 ? 'opacity-40 cursor-not-allowed' : ''}`}
                    >
                      <History className="w-4 h-4" /> Old Dues
                      <span className="text-[10px] text-muted-foreground">Oldest first</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setCollectMode('advance_first')}
                      disabled={advanceBalance <= 0}
                      className={`flex flex-col items-center gap-1 px-2 py-2.5 rounded-xl border-2 text-[11px] font-medium transition ${mode === 'advance_first' ? 'text-blue-700 bg-blue-50 border-blue-600 ring-2 ring-blue-500/10' : 'border-border text-muted-foreground hover:border-blue-200 hover:bg-blue-50/30'} ${advanceBalance <= 0 ? 'opacity-40 cursor-not-allowed' : ''}`}
                    >
                      <Wallet className="w-4 h-4" /> Advance
                      <span className="text-[10px] text-muted-foreground">Held money first</span>
                    </button>
                  </div>
                  {mode === 'dues_first' && (
                    <p className="text-[11px] text-amber-700 mt-1.5">
                      The cash received clears {formatCurrency(previousDueTotal)} of old dues oldest-first;
                      whatever is left pays this bill and the remainder stays due on this customer.
                    </p>
                  )}
                  {mode === 'advance_first' && (
                    <p className="text-[11px] text-blue-700 mt-1.5">
                      {formatCurrency(advanceBalance)} of advance balance pays this bill first; only the
                      remainder is collected in cash.
                    </p>
                  )}
                </div>
              )}

              {/* Payment Terms — the account modes derive the term themselves */}
              {mode === 'cash' && (
              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-2">PAYMENT TERMS</label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => setPaymentTerm('full')}
                    className={`flex flex-col items-center gap-1 px-2 py-2.5 rounded-xl border-2 text-xs font-medium transition ${paymentTerm === 'full' ? 'text-green-700 bg-green-50 border-green-600 ring-2 ring-green-500/10' : 'border-border text-muted-foreground hover:border-green-200 hover:bg-green-50/30'}`}
                  >
                    <CheckCircle2 className="w-4 h-4" /> Full
                    <span className="text-[10px] text-muted-foreground">Pay all now</span>
                  </button>
                  <button
                    onClick={() => setPaymentTerm('partial')}
                    disabled={isWalkIn}
                    className={`flex flex-col items-center gap-1 px-2 py-2.5 rounded-xl border-2 text-xs font-medium transition ${paymentTerm === 'partial' ? 'text-amber-700 bg-amber-50 border-amber-600 ring-2 ring-amber-500/10' : 'border-border text-muted-foreground hover:border-amber-200 hover:bg-amber-50/30'} ${isWalkIn ? 'opacity-40 cursor-not-allowed' : ''}`}
                  >
                    <DollarSign className="w-4 h-4" /> Partial
                    <span className="text-[10px] text-muted-foreground">Pay some now</span>
                  </button>
                  <button
                    onClick={() => setPaymentTerm('credit')}
                    disabled={isWalkIn}
                    className={`flex flex-col items-center gap-1 px-2 py-2.5 rounded-xl border-2 text-xs font-medium transition ${paymentTerm === 'credit' ? 'text-blue-700 bg-blue-50 border-blue-600 ring-2 ring-blue-500/10' : 'border-border text-muted-foreground hover:border-blue-200 hover:bg-blue-50/30'} ${isWalkIn ? 'opacity-40 cursor-not-allowed' : ''}`}
                  >
                    <Clock className="w-4 h-4" /> On Credit
                    <span className="text-[10px] text-muted-foreground">Pay later</span>
                  </button>
                </div>
                {isWalkIn && (paymentTerm === 'partial' || paymentTerm === 'credit') && (
                  <p className="text-[11px] text-amber-600 mt-1.5">Partial and credit terms require a selected customer. Walk-in customers must use full payment.</p>
                )}
              </div>
              )}

              {/* Partial payment amount input */}
              {mode === 'cash' && paymentTerm === 'partial' && (
                <div>
                  <label className="block text-xs font-semibold text-muted-foreground mb-1.5">PARTIAL PAYMENT AMOUNT</label>
                  <UnitInput
                    prefix="৳"
                    min="0.01"
                    max={total - 0.01}
                    step="0.01"
                    value={partialAmount}
                    onChange={e => setPartialAmount(e.target.value)}
                    placeholder={`Enter amount (Max: ${formatCurrency(total)})`}
                    className="border-amber-300 bg-amber-50/30 rounded-lg text-base font-semibold focus:ring-amber-500/20"
                  />
                  <p className="text-xs text-amber-700 mt-1 font-medium">
                    Balance Due After Payment: {formatCurrency(total - partialNum)}
                  </p>
                </div>
              )}

              {/* Payment method grid — hidden only when nothing is collected now */}
              {(mode !== 'cash' || paymentTerm !== 'credit') && (
                <div>
                  <label className="block text-xs font-semibold text-muted-foreground mb-2">PAYMENT METHOD</label>
                  <div className="grid grid-cols-2 gap-2">
                    {displayMethods.map(m => {
                      const Icon = paymentMethodIcons[m.code] || Banknote;
                      const color = paymentMethodColors[m.code] || 'text-gray-600 bg-gray-50 border-gray-200';
                      const selected = paymentMethod === m.code;
                      return (
                        <button
                          key={m.code}
                          onClick={() => setPaymentMethod(m.code)}
                          className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 text-sm font-medium transition ${selected ? color + ' border-current ring-2 ring-current/10' : 'border-border text-muted-foreground hover:border-blue-200 hover:bg-muted/30'}`}
                        >
                          <Icon className="w-4 h-4" />{m.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Store credit option */}
              {storeCreditBalance > 0 && selectedCustomer && (mode !== 'cash' || paymentTerm !== 'credit') && (
                <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <div>
                    <p className="text-xs font-semibold text-amber-800">Apply Store Credit</p>
                    <p className="text-[11px] text-amber-700">Balance: {formatCurrency(storeCreditBalance)}</p>
                  </div>
                  <button
                    onClick={() => setApplyStoreCredit(!applyStoreCredit)}
                    className={`w-10 h-5 rounded-full transition relative ${applyStoreCredit ? 'bg-amber-500' : 'bg-gray-300'}`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${applyStoreCredit ? 'left-5' : 'left-0.5'}`} />
                  </button>
                </div>
              )}

              {/* Previous-due collection — full payment, registered customer, online */}
              {showDueCollect && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-amber-800">Previous Due: {formatCurrency(previousDueTotal)}</p>
                    <p className="text-[11px] text-amber-700">{customerOutstanding.length} invoice(s)</p>
                  </div>
                  <UnitInput
                    prefix="৳"
                    min="0"
                    max={previousDueTotal}
                    step="0.01"
                    value={dueCollectInput}
                    onChange={e => setDueCollectInput(e.target.value)}
                    placeholder={`Collect previous due now (max ${formatCurrency(previousDueTotal)})`}
                    className="border-amber-300 bg-white rounded-lg font-semibold focus:ring-amber-500/20"
                  />
                  {dueCollectNum > 0 && (
                    <div className="space-y-0.5">
                      {dueAllocPreview.map(a => (
                        <div key={a.invoice_id} className="flex justify-between text-[11px] text-amber-700">
                          <span>{a.invoice_number}</span>
                          <span>{formatCurrency(a.amount)}</span>
                        </div>
                      ))}
                      <p className="text-[11px] text-amber-800 font-medium pt-0.5">
                        Remaining previous due after collection: {formatCurrency(previousDueTotal - dueCollectNum)}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Amount paid input — cash mode keeps the term-driven label */}
              {mode === 'cash' && paymentTerm !== 'credit' && (
                <div>
                  <label className="block text-xs font-semibold text-muted-foreground mb-1.5">AMOUNT PAID</label>
                  <UnitInput
                    prefix="৳"
                    min="0"
                    step="0.01"
                    value={amountPaid}
                    onChange={e => setAmountPaid(e.target.value)}
                    placeholder={total.toFixed(2)}
                    className="rounded-lg text-base font-semibold"
                  />
                  {paid > 0 && (
                    <p className={`text-xs mt-1 ${effectiveChange >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                      {effectiveChange >= 0 ? `Change: ${formatCurrency(effectiveChange)}` : `Remaining: ${formatCurrency(-effectiveChange)}`}
                    </p>
                  )}
                </div>
              )}

              {/* Account modes — cash received, plus exactly what it does */}
              {mode !== 'cash' && (
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
                      CASH RECEIVED
                    </label>
                    <UnitInput
                      prefix="৳"
                      min="0"
                      step="0.01"
                      value={amountPaid}
                      onChange={e => setAmountPaid(e.target.value)}
                      placeholder={accountModeNeeds.toFixed(2)}
                      className="rounded-lg text-base font-semibold"
                    />
                  </div>
                  {mode === 'dues_first' ? (
                    <DuesSplitPreview settlement={settlement} total={total} />
                  ) : (
                    <AdvanceSplitPreview settlement={settlement} total={total} advanceBalance={advanceBalance} />
                  )}
                </div>
              )}
            </>
          ) : (
            /* Confirmation step */
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 bg-blue-50 rounded-xl">
                <div className="flex items-center gap-2">
                  {(() => {
                    const Icon = paymentMethodIcons[paymentMethod] || Banknote;
                    return <Icon className="w-5 h-5 text-blue-600" />;
                  })()}
                  <span className="text-sm font-semibold">{paymentTerm === 'credit' ? 'On Credit' : (displayMethods.find(m => m.code === paymentMethod)?.name || paymentMethod)}</span>
                </div>
                <button onClick={() => setStep('method')} className="text-xs text-blue-600 hover:underline">Change</button>
              </div>

              <div className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Customer</span><span className="font-medium truncate max-w-[180px]">{customerName}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Items</span><span className="font-medium">{cart.length}</span></div>
                {mode === 'cash' && (
                  <div className="flex justify-between"><span className="text-muted-foreground">Payment Term</span><span className="font-medium">{paymentTerm === 'full' ? 'Full Payment' : paymentTerm === 'partial' ? 'Partial Payment' : 'On Credit'}</span></div>
                )}
                {mode === 'dues_first' && <div className="flex justify-between"><span className="text-muted-foreground">Collect From</span><span className="font-medium text-amber-700">Previous Dues First</span></div>}
                {mode === 'advance_first' && <div className="flex justify-between"><span className="text-muted-foreground">Collect From</span><span className="font-medium text-blue-700">Advance Balance First</span></div>}
                {mode === 'cash' && paymentTerm === 'full' && <div className="flex justify-between"><span className="text-muted-foreground">Amount Paid</span><span className="font-medium">{formatCurrency(paid || total)}</span></div>}
                {mode === 'cash' && paymentTerm === 'partial' && <div className="flex justify-between"><span className="text-muted-foreground">Amount Paid</span><span className="font-medium">{formatCurrency(partialNum)}</span></div>}
                {mode === 'cash' && paymentTerm === 'partial' && <div className="flex justify-between text-amber-600"><span className="text-muted-foreground">Balance Due</span><span className="font-medium">{formatCurrency(total - partialNum)}</span></div>}
                {mode === 'cash' && paymentTerm === 'credit' && <div className="flex justify-between text-blue-600"><span className="text-muted-foreground">Balance Due</span><span className="font-medium">{formatCurrency(total)}</span></div>}
                {showDueCollect && dueCollectNum > 0 && <div className="flex justify-between text-amber-700"><span>Previous Due Collected</span><span className="font-medium">{formatCurrency(dueCollectNum)}</span></div>}
                {mode === 'dues_first' && <div className="flex justify-between text-amber-700"><span>Old Dues Cleared</span><span className="font-medium">{formatCurrency(settlement.duesCleared)}</span></div>}
                {mode === 'advance_first' && <div className="flex justify-between text-blue-700"><span>Advance Applied</span><span className="font-medium">{formatCurrency(settlement.advanceApplied)}</span></div>}
                {(mode !== 'cash' || paymentTerm !== 'credit') && <div className="flex justify-between"><span className="text-muted-foreground">Cash Received</span><span className="font-medium">{formatCurrency(mode === 'cash' ? paid : settlement.tendered)}</span></div>}
                {mode !== 'cash' && <div className="flex justify-between text-blue-600"><span>Left Due On This Bill</span><span className="font-medium">{formatCurrency(Math.max(0, round2(total - settlement.invoicePaidTotal)))}</span></div>}
                {mode === 'cash' && paymentTerm === 'full' && paid > 0 && effectiveChange >= 0 && <div className="flex justify-between"><span className="text-muted-foreground">Change</span><span className="font-medium text-green-600">{formatCurrency(effectiveChange)}</span></div>}
                {mode !== 'cash' && settlement.change > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Change</span><span className="font-medium text-green-600">{formatCurrency(settlement.change)}</span></div>}
                {applyStoreCredit && storeCreditBalance > 0 && (mode !== 'cash' || paymentTerm !== 'credit') && <div className="flex justify-between text-amber-700"><span>Store Credit Applied</span><span className="font-medium">{formatCurrency(Math.min(storeCreditBalance, total))}</span></div>}
              </div>

              <div className="bg-muted/30 rounded-xl p-3 space-y-1 text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">Cost Price (total)</span><span>{formatCurrency(totalCost)}</span></div>
                <div className="flex justify-between font-semibold"><span>Est. Profit</span><span className="text-green-600">{formatCurrency(profit)}</span></div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border flex gap-2 shrink-0">
          {step === 'method' ? (
            <>
              <button onClick={onClose} className="flex-1 px-4 py-2.5 border border-border rounded-lg text-sm font-medium hover:bg-muted transition">Cancel</button>
              <button
                onClick={() => setStep('confirm')}
                disabled={!paymentMethod && paymentTerm !== 'credit'}
                className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                Next <ArrowRight className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setStep('method')} className="flex-1 px-4 py-2.5 border border-border rounded-lg text-sm font-medium hover:bg-muted transition flex items-center justify-center gap-1.5">
                <ArrowLeft className="w-4 h-4" /> Back
              </button>
              <button
                onClick={onConfirm}
                disabled={processing}
                className="flex-1 px-4 py-2.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-bold transition disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                <CheckCircle2 className="w-4 h-4" /> {processing ? 'Processing...' : `Charge ${formatCurrency(paymentTerm === 'partial' ? partialNum : total)}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
