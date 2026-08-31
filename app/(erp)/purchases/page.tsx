'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatDate } from '@/lib/format';
import { toast } from '@/hooks/use-toast';
import { Plus, Search, Eye, X, Trash2, CircleCheck as CheckCircle, Truck, DollarSign, CreditCard, Printer, UserPlus, Pencil, Ban, Undo2, ChevronLeft, ChevronRight, Calendar, Bell, Package, ShoppingBag } from 'lucide-react';
import type { PurchaseOrder, PurchaseOrderStatus, Supplier, Product, PaymentMethod, ProductUnit, PurchaseReminder } from '@/lib/types';
import { isMultiUnitEnabled, getDefaultSaleUnit, convertToBaseUnit } from '@/lib/unit-utils';
import ProductSearchInput from '@/components/ui/ProductSearchInput';
import SupplierSearchInput from '@/components/ui/SupplierSearchInput';

const statusConfig: Record<PurchaseOrderStatus, { label: string; color: string; bg: string }> = {
  draft: { label: 'Draft', color: 'text-gray-600', bg: 'bg-gray-100' },
  pending_approval: { label: 'Pending Approval', color: 'text-amber-600', bg: 'bg-amber-100' },
  approved: { label: 'Approved', color: 'text-blue-600', bg: 'bg-blue-100' },
  partially_received: { label: 'Partial', color: 'text-orange-600', bg: 'bg-orange-100' },
  received: { label: 'Received', color: 'text-green-600', bg: 'bg-green-100' },
  cancelled: { label: 'Cancelled', color: 'text-red-600', bg: 'bg-red-100' },
};

interface PurchaseOrderWithSupplier extends Omit<PurchaseOrder, 'supplier'> {
  supplier_id: string;
  supplier?: { name: string; code: string; phone?: string };
}

export default function PurchasesPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<PurchaseOrderWithSupplier[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [stats, setStats] = useState({ total: 0, pending: 0, received: 0, outstanding: 0, returns: 0, returnAmount: 0, totalValue: 0 });
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [viewingOrder, setViewingOrder] = useState<PurchaseOrderWithSupplier | null>(null);
  const [orderItems, setOrderItems] = useState<any[]>([]);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentOrder, setPaymentOrder] = useState<PurchaseOrderWithSupplier | null>(null);
  const [editingOrder, setEditingOrder] = useState<PurchaseOrderWithSupplier | null>(null);
  const [cancellingOrder, setCancellingOrder] = useState<PurchaseOrderWithSupplier | null>(null);
  const [poReturns, setPoReturns] = useState<Record<string, { return_number: string; total_amount: number }[]>>({});

  // Date filter state
  const [dateFilter, setDateFilter] = useState<'all' | 'today' | 'week' | 'month' | 'quarter' | 'year' | 'custom'>('all');
  const [customDateFrom, setCustomDateFrom] = useState('');
  const [customDateTo, setCustomDateTo] = useState('');

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [purchaseReminders, setPurchaseReminders] = useState<(PurchaseReminder & { product?: any; quotation?: any })[]>([]);
  const [loadingReminders, setLoadingReminders] = useState(true);
  const [selectedReminders, setSelectedReminders] = useState<Set<string>>(new Set());
  const pageSize = 10;

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    const [poRes, supRes, prodRes, returnsRes] = await Promise.all([
      supabase.from('purchase_orders').select('*, supplier:suppliers(name, code, phone)').order('created_at', { ascending: false }),
      supabase.from('suppliers').select('*').eq('is_active', true).order('name'),
      supabase.from('products').select('*').eq('is_active', true).order('name'),
      supabase.from('purchase_returns').select('id, return_number, total_amount, status, purchase_order_id').order('created_at', { ascending: false }),
    ]);
    setOrders(poRes.data || []);
    setSuppliers(supRes.data || []);
    setProducts(prodRes.data || []);

    // Build a map of PO ID -> returns for quick lookup
    const returnsMap: Record<string, { return_number: string; total_amount: number }[]> = {};
    (returnsRes.data || []).forEach((r: any) => {
      if (r.status === 'completed' && r.purchase_order_id) {
        if (!returnsMap[r.purchase_order_id]) returnsMap[r.purchase_order_id] = [];
        returnsMap[r.purchase_order_id].push({ return_number: r.return_number, total_amount: Number(r.total_amount) });
      }
    });
    setPoReturns(returnsMap);

    const all = poRes.data || [];
    setStats({
      total: all.length,
      pending: all.filter((o: any) => ['draft', 'pending_approval', 'approved'].includes(o.status)).length,
      received: all.filter((o: any) => o.status === 'received').length,
      outstanding: all.filter((o: any) => o.status !== 'cancelled').reduce((s: number, o: any) => s + Math.max(0, Number(o.total_amount) - Number(o.amount_paid)), 0),
      returns: (returnsRes.data || []).filter((r: any) => r.status === 'completed').length,
      returnAmount: (returnsRes.data || []).filter((r: any) => r.status === 'completed').reduce((s: number, r: any) => s + Number(r.total_amount), 0),
      totalValue: all.filter((o: any) => o.status !== 'cancelled').reduce((s: number, o: any) => s + Number(o.total_amount), 0),
    });

    // Load purchase reminders
    setLoadingReminders(true);
    const { data: reminders } = await supabase
      .from("purchase_reminders")
      .select("*, product:products(id, name, sku, unit, cost_price, min_stock_level, image_url), quotation:quotations(quote_number, customer:customers(name))")
      .eq("status", "pending")
      .order("created_at", { ascending: false });
    setPurchaseReminders((reminders || []) as any);
    setLoadingReminders(false);
    setLoading(false);
  }

  // Date filtering helper
  async function dismissReminder(reminderId: string) {
    await supabase.from("purchase_reminders").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", reminderId);
    setPurchaseReminders(prev => prev.filter(r => r.id !== reminderId));
    setSelectedReminders(prev => { const next = new Set(prev); next.delete(reminderId); return next; });
    toast({ title: "Dismissed", description: "Purchase reminder dismissed" });
  }

  function toggleReminderSelection(reminderId: string) {
    setSelectedReminders(prev => {
      const next = new Set(prev);
      if (next.has(reminderId)) next.delete(reminderId); else next.add(reminderId);
      return next;
    });
  }

  function selectAllReminders() {
    if (selectedReminders.size === purchaseReminders.length) {
      setSelectedReminders(new Set());
    } else {
      setSelectedReminders(new Set(purchaseReminders.map(r => r.id)));
    }
  }

  function createBulkPO() {
    if (selectedReminders.size === 0) return;
    const productIds = purchaseReminders
      .filter(r => selectedReminders.has(r.id))
      .map(r => r.product_id)
      .filter(Boolean);
    if (productIds.length === 0) return;
    // Store selected product IDs in sessionStorage so CreatePOModal can pick them up
    sessionStorage.setItem('bulkReminderProducts', JSON.stringify(productIds));
    sessionStorage.setItem('bulkReminderIds', JSON.stringify(Array.from(selectedReminders)));
    setShowCreateModal(true);
  }
  function getDateRange() {
    if (dateFilter === 'all') return null;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (dateFilter === 'today') return { from: today.toISOString().split('T')[0], to: today.toISOString().split('T')[0] };
    if (dateFilter === 'week') {
      const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
      return { from: weekAgo.toISOString().split('T')[0], to: today.toISOString().split('T')[0] };
    }
    if (dateFilter === 'month') {
      const monthAgo = new Date(today); monthAgo.setMonth(monthAgo.getMonth() - 1);
      return { from: monthAgo.toISOString().split('T')[0], to: today.toISOString().split('T')[0] };
    }
    if (dateFilter === 'quarter') {
      const quarterAgo = new Date(today); quarterAgo.setMonth(quarterAgo.getMonth() - 3);
      return { from: quarterAgo.toISOString().split('T')[0], to: today.toISOString().split('T')[0] };
    }
    if (dateFilter === 'year') {
      const yearAgo = new Date(today); yearAgo.setFullYear(yearAgo.getFullYear() - 1);
      return { from: yearAgo.toISOString().split('T')[0], to: today.toISOString().split('T')[0] };
    }
    if (dateFilter === 'custom' && customDateFrom && customDateTo) {
      return { from: customDateFrom, to: customDateTo };
    }
    return null;
  }

  // Stats filtered by date range
  function getFilteredStats(filteredOrders: PurchaseOrderWithSupplier[]) {
    const active = filteredOrders.filter((o: any) => o.status !== 'cancelled');
    let returnCount = 0;
    let returnAmountTotal = 0;
    Object.entries(poReturns).forEach(([poId, returns]) => {
      if (filteredOrders.some((o: any) => o.id === poId)) {
        returnCount += returns.length;
        returnAmountTotal += returns.reduce((rs: number, r: any) => rs + r.total_amount, 0);
      }
    });
    return {
      total: filteredOrders.length,
      pending: filteredOrders.filter((o: any) => ['draft', 'pending_approval', 'approved'].includes(o.status)).length,
      received: filteredOrders.filter((o: any) => o.status === 'received').length,
      outstanding: active.reduce((s: number, o: any) => s + Math.max(0, Number(o.total_amount) - Number(o.amount_paid)), 0),
      returns: returnCount,
      returnAmount: returnAmountTotal,
      totalValue: active.reduce((s: number, o: any) => s + Number(o.total_amount), 0),
    };
  }

  async function viewOrderDetails(order: PurchaseOrderWithSupplier) {
    const { data } = await supabase
      .from('purchase_order_items')
      .select('*, product:products(name, sku, unit)')
      .eq('purchase_order_id', order.id);
    setOrderItems(data || []);
    setViewingOrder(order);
  }

  function openPaymentModal(order: PurchaseOrderWithSupplier) {
    setPaymentOrder(order);
    setShowPaymentModal(true);
  }

  function openEditModal(order: PurchaseOrderWithSupplier) {
    setEditingOrder(order);
  }

  async function cancelOrder(order: PurchaseOrderWithSupplier) {
    const { error } = await supabase
      .from('purchase_orders')
      .update({ status: 'cancelled', amount_paid: order.total_amount, updated_at: new Date().toISOString() })
      .eq('id', order.id);
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
      return;
    }

    // The database trigger (purchase_order_cancellation_trigger) handles:
    // - Reversing the receipt journal entry (Dr AP / Cr Inventory) using NET total
    // - Reversing all payment journal entries (Dr Cash / Cr AP)
    // - Reversing account balances
    // We only handle stock and supplier balance here.

    // Reverse supplier outstanding balance and total_purchases
    const { data: supplier } = await supabase
      .from('suppliers')
      .select('outstanding_balance, total_purchases')
      .eq('id', order.supplier_id)
      .single();
    if (supplier) {
      await supabase
        .from('suppliers')
        .update({
          outstanding_balance: Math.max(0, (supplier.outstanding_balance || 0) - Number(order.total_amount)),
          total_purchases: Math.max(0, (supplier.total_purchases || 0) - Number(order.total_amount)),
          updated_at: new Date().toISOString(),
        })
        .eq('id', order.supplier_id);
    }

    // Mark any payments for this PO as reversed
    if (Number(order.amount_paid) > 0) {
      await supabase
        .from('payments')
        .update({ is_reversed: true })
        .eq('reference_type', 'purchase_order')
        .eq('reference_id', order.id)
        .eq('is_reversed', false);
    }

    // If order was received, reverse stock additions
    if (order.status === 'received' || order.status === 'partially_received') {
      const { data: poItems } = await supabase
        .from('purchase_order_items')
        .select('product_id, quantity, warehouse_id, base_quantity')
        .eq('purchase_order_id', order.id);

      const { data: whData } = await supabase
        .from('warehouses')
        .select('id')
        .eq('is_default', true)
        .limit(1);
      const defaultWhId = whData && whData.length > 0 ? whData[0].id : null;

      for (const item of poItems || []) {
        const warehouseId = item.warehouse_id || defaultWhId;
        if (!warehouseId) continue;
        const qtyToReverse = Number(item.base_quantity || item.quantity);

        const { data: invData } = await supabase
          .from('inventory_items')
          .select('id, quantity_on_hand')
          .eq('product_id', item.product_id)
          .eq('warehouse_id', warehouseId)
          .limit(1);

        if (invData && invData.length > 0) {
          await supabase
            .from('inventory_items')
            .update({
              quantity_on_hand: Math.max(0, (invData[0].quantity_on_hand || 0) - qtyToReverse),
              updated_at: new Date().toISOString(),
            })
            .eq('id', invData[0].id);
        }

        await supabase.from('stock_movements').insert({
          product_id: item.product_id,
          warehouse_id: warehouseId,
          movement_type: 'purchase_return',
          quantity: -qtyToReverse,
          reference_type: 'purchase_order',
          reference_id: order.id,
          reference_number: order.po_number,
          notes: 'Stock reversed on PO cancellation',
        });
      }
    }

    toast({ title: 'Success', description: `Purchase order ${order.po_number} cancelled` });
    setCancellingOrder(null);
    loadData();
  }

  async function updateOrderStatus(order: PurchaseOrderWithSupplier, newStatus: PurchaseOrderStatus) {
    const { error } = await supabase
      .from('purchase_orders')
      .update({ status: newStatus })
      .eq('id', order.id);
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
      return;
    }

    // If marking as received, add stock to inventory
    if (newStatus === 'received' || newStatus === 'partially_received') {
      // Guard against duplicate stock movements on re-receive
      const { data: existingMovements } = await supabase
        .from('stock_movements')
        .select('id')
        .eq('reference_type', 'purchase_order')
        .eq('reference_id', order.id)
        .limit(1);

      if (existingMovements && existingMovements.length > 0) {
        toast({ title: 'Info', description: 'Stock already received for this order' });
        loadData();
        return;
      }

      const { data: poItems } = await supabase
        .from('purchase_order_items')
        .select('*, product_id, quantity, unit_cost, warehouse_id, unit_name, unit_conversion_factor, base_quantity')
        .eq('purchase_order_id', order.id);

      // Find default warehouse once
      const { data: whData } = await supabase
        .from('warehouses')
        .select('id')
        .eq('is_default', true)
        .limit(1);
      const defaultWhId = whData && whData.length > 0 ? whData[0].id : null;

      for (const item of poItems || []) {
        const warehouseId = item.warehouse_id || defaultWhId;
        if (!warehouseId) continue;

        const qtyToAdd = Number(item.base_quantity || item.quantity);

        // Find existing inventory for this product+warehouse
        const { data: invData } = await supabase
          .from('inventory_items')
          .select('id, quantity_on_hand')
          .eq('product_id', item.product_id)
          .eq('warehouse_id', warehouseId)
          .limit(1);

        if (invData && invData.length > 0) {
          const currentQty = invData[0].quantity_on_hand || 0;
          await supabase
            .from('inventory_items')
            .update({
              quantity_on_hand: currentQty + qtyToAdd,
              updated_at: new Date().toISOString()
            })
            .eq('id', invData[0].id);
        } else {
          await supabase.from('inventory_items').insert({
            product_id: item.product_id,
            warehouse_id: warehouseId,
            quantity_on_hand: qtyToAdd,
            quantity_reserved: 0,
            quantity_incoming: 0,
          });
        }

        // Record stock movement
        await supabase.from('stock_movements').insert({
          product_id: item.product_id,
          warehouse_id: warehouseId,
          movement_type: 'purchase',
          quantity: qtyToAdd,
          unit_cost: item.unit_cost,
          reference_type: 'purchase_order',
          reference_id: order.id,
          reference_number: order.po_number,
          notes: 'Purchase received',
        });
      }

      // Update received_quantity on all PO items to match ordered quantity
      await supabase
        .from('purchase_order_items')
        .update({ received_quantity: poItems?.map((it: any) => ({ id: it.id, qty: Number(it.base_quantity || it.quantity) })) })
        .in('id', poItems?.map((it: any) => it.id) || []);

      // Set received_quantity per item individually (bulk update with different values not supported)
      for (const item of (poItems || [])) {
        await supabase
          .from('purchase_order_items')
          .update({ received_quantity: Number(item.base_quantity || item.quantity) })
          .eq('id', item.id);
      }
    }

    toast({ title: 'Success', description: `Order ${newStatus === 'approved' ? 'approved' : newStatus}` });
    loadData();
    if (viewingOrder?.id === order.id) {
      setViewingOrder({ ...viewingOrder, status: newStatus });
    }
  }

  const dateRange = getDateRange();
  const filtered = orders.filter(o => {
    const matchSearch = !search || o.po_number.toLowerCase().includes(search.toLowerCase()) || o.supplier?.name?.toLowerCase().includes(search.toLowerCase());
    const matchStatus = !filterStatus || o.status === filterStatus;
    const matchDate = !dateRange || (o.order_date >= dateRange.from && o.order_date <= dateRange.to);
    return matchSearch && matchStatus && matchDate;
  });

  // Reset to page 1 when filters change
  useEffect(() => { setCurrentPage(1); }, [search, filterStatus, dateFilter, customDateFrom, customDateTo]);

  const dateFilteredStats = getFilteredStats(filtered);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paginatedOrders = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Purchase Orders</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Manage procurement and supplier orders</p>
        </div>
        <button onClick={() => setShowCreateModal(true)} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition">
          <Plus className="w-4 h-4" />New Purchase Order
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {[
          { label: 'Total Orders', value: dateFilteredStats.total, color: 'text-blue-500' },
          { label: 'Total Value', value: formatCurrency(dateFilteredStats.totalValue), color: 'text-blue-600' },
          { label: 'Pending', value: dateFilteredStats.pending, color: 'text-amber-500' },
          { label: 'Received', value: dateFilteredStats.received, color: 'text-green-500' },
          { label: 'Outstanding', value: formatCurrency(dateFilteredStats.outstanding), color: 'text-red-500' },
          { label: 'Returns', value: dateFilteredStats.returns, subValue: formatCurrency(dateFilteredStats.returnAmount), color: 'text-purple-500' },
        ].map(s => (
          <div key={s.label} className="stat-card">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p className={`text-xl font-bold mt-1 ${s.color}`}>{s.value}</p>
            {s.subValue && <p className={`text-xs mt-0.5 ${s.color} opacity-70`}>{s.subValue}</p>}
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-border p-4 shadow-sm flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search orders..." className="w-full pl-8 pr-4 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
        </div>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border border-border rounded-lg px-3 py-2 text-sm focus:outline-none">
          <option value="">All Status</option>
          {Object.entries(statusConfig).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-muted-foreground" />
          <select value={dateFilter} onChange={e => setDateFilter(e.target.value as any)} className="border border-border rounded-lg px-3 py-2 text-sm focus:outline-none">
            <option value="all">All Time</option>
            <option value="today">Today</option>
            <option value="week">Last 7 Days</option>
            <option value="month">Last 30 Days</option>
            <option value="quarter">Last 3 Months</option>
            <option value="year">Last Year</option>
            <option value="custom">Custom Range</option>
          </select>
        </div>
        {dateFilter === 'custom' && (
          <div className="flex items-center gap-2">
            <input type="date" value={customDateFrom} onChange={e => setCustomDateFrom(e.target.value)} className="border border-border rounded-lg px-2 py-2 text-sm focus:outline-none" />
            <span className="text-xs text-muted-foreground">to</span>
            <input type="date" value={customDateTo} onChange={e => setCustomDateTo(e.target.value)} className="border border-border rounded-lg px-2 py-2 text-sm focus:outline-none" />
          </div>
        )}
      </div>

      {/* Purchase Reminders Section */}
      {purchaseReminders.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Bell className="w-5 h-5 text-amber-600" />
              <h3 className="text-sm font-bold text-amber-800">Purchase Reminders</h3>
              <span className="bg-amber-200 text-amber-800 text-xs font-bold px-2 py-0.5 rounded-full">{purchaseReminders.length}</span>
            </div>
            <div className="flex items-center gap-2">
              {selectedReminders.size > 0 && (
                <button
                  onClick={createBulkPO}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold transition"
                >
                  <ShoppingBag className="w-3.5 h-3.5" />
                  Create PO ({selectedReminders.size})
                </button>
              )}
              <button
                onClick={selectAllReminders}
                className="text-xs px-2 py-1 rounded border border-amber-300 text-amber-700 hover:bg-amber-100 transition"
              >
                {selectedReminders.size === purchaseReminders.length ? 'Deselect All' : 'Select All'}
              </button>
              <Link
                href="/purchases/reminders"
                className="text-xs text-amber-700 hover:text-amber-900 underline font-medium"
              >
                View All →
              </Link>
            </div>
          </div>
          <p className="text-xs text-amber-700 mb-3">Products marked for purchase from quotation low stock. Select items and create a purchase order, or dismiss individual reminders.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {purchaseReminders.map((reminder) => {
              const prod = reminder.product;
              const quot = reminder.quotation;
              const isSelected = selectedReminders.has(reminder.id);
              return (
                <div key={reminder.id} className={`bg-white border rounded-lg p-3 flex gap-3 transition ${isSelected ? 'border-blue-400 ring-1 ring-blue-200' : 'border-amber-200'}`}>
                  <div className="flex flex-col items-center gap-1 shrink-0">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleReminderSelection(reminder.id)}
                      className="rounded border-amber-300 text-blue-600 focus:ring-blue-500"
                    />
                    <div className="w-10 h-10 bg-amber-100 rounded-lg overflow-hidden flex items-center justify-center">
                      {prod?.image_url ? (
                        <img src={prod.image_url} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <Package className="w-5 h-5 text-amber-600" />
                      )}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">{prod?.name || 'Unknown Product'}</p>
                    <p className="text-[10px] text-muted-foreground">{prod?.sku || ''}</p>
                    <div className="flex items-center gap-2 mt-1 text-[10px]">
                      <span className="text-amber-600 font-medium">Stock: {reminder.current_stock}</span>
                      <span className="text-muted-foreground">|</span>
                      <span className="text-blue-600 font-medium">Need: {reminder.quantity_needed}</span>
                    </div>
                    {quot && (
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        From: {quot.quote_number} {quot.customer?.name ? `(${quot.customer.name})` : ''}
                      </p>
                    )}
                    {prod?.cost_price ? (
                      <p className="text-[10px] text-green-600 mt-0.5">Est. cost: {formatCurrency(prod.cost_price * reminder.quantity_needed)}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    <button
                      onClick={() => {
                        sessionStorage.setItem('bulkReminderProducts', JSON.stringify([reminder.product_id]));
                        sessionStorage.setItem('bulkReminderIds', JSON.stringify([reminder.id]));
                        setShowCreateModal(true);
                      }}
                      className="text-[10px] px-2 py-1 bg-blue-100 text-blue-700 rounded font-medium hover:bg-blue-200 transition"
                    >
                      Create PO
                    </button>
                    <button
                      onClick={() => dismissReminder(reminder.id)}
                      className="text-[10px] px-2 py-1 bg-gray-100 text-gray-600 rounded font-medium hover:bg-gray-200 transition"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="table-wrapper">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-muted/40 border-b border-border">
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">PO #</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Supplier</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Order Date</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Expected</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Amount</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Paid</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Balance</th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-3">Status</th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 9 }).map((_, j) => <td key={j} className="px-4 py-3"><div className="h-4 bg-muted rounded animate-pulse" /></td>)}</tr>
              )) : paginatedOrders.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-12 text-center text-muted-foreground text-sm">No purchase orders found</td></tr>
              ) : paginatedOrders.map((o) => {
                const cfg = statusConfig[o.status as PurchaseOrderStatus] || statusConfig.draft;
                const isCancelled = o.status === 'cancelled';
                const balance = isCancelled ? 0 : Number(o.total_amount) - Number(o.amount_paid);
                const returns = poReturns[o.id] || [];
                return (
                  <tr key={o.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-semibold text-blue-600">{o.po_number}</span>
                        {returns.length > 0 && (
                          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-purple-100 text-purple-700" title={`Returned: ${returns.map(r => r.return_number).join(', ')}`}>
                            <Undo2 className="w-2.5 h-2.5" /> {returns.length}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-foreground">{o.supplier?.name || '-'}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{formatDate(o.order_date)}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{o.expected_date ? formatDate(o.expected_date) : '-'}</td>
                    <td className="px-4 py-3 text-right text-sm font-semibold text-foreground">{formatCurrency(o.total_amount)}</td>
                    <td className="px-4 py-3 text-right text-sm text-green-600 font-semibold">{formatCurrency(o.amount_paid)}</td>
                    <td className="px-4 py-3 text-right text-sm font-bold text-red-600">{balance > 0 ? formatCurrency(balance) : '-'}</td>
                    <td className="px-4 py-3"><span className={`badge-status ${cfg.bg} ${cfg.color}`}>{cfg.label}</span></td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {balance > 0 && (o.status === 'approved' || o.status === 'received' || o.status === 'partially_received') && (
                          <button onClick={() => openPaymentModal(o)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-green-50 text-muted-foreground hover:text-green-600 transition" title="Record Payment">
                            <DollarSign className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {(o.status === 'draft' || o.status === 'approved') && (
                          <button onClick={() => openEditModal(o)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition" title="Edit Order">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {(o.status === 'draft' || o.status === 'approved') && (
                          <button onClick={() => setCancellingOrder(o)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-50 text-muted-foreground hover:text-red-600 transition" title="Cancel Order">
                            <Ban className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button onClick={() => viewOrderDetails(o)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition" title="View Details">
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 border-t border-border flex items-center justify-between">
          <p className="text-xs text-muted-foreground">Showing {paginatedOrders.length} of {filtered.length} orders</p>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="w-7 h-7 flex items-center justify-center rounded-lg border border-border hover:bg-muted transition disabled:opacity-40 disabled:cursor-not-allowed">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs text-muted-foreground">Page {currentPage} of {totalPages}</span>
              <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="w-7 h-7 flex items-center justify-center rounded-lg border border-border hover:bg-muted transition disabled:opacity-40 disabled:cursor-not-allowed">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {showCreateModal && (
        <CreatePOModal
          suppliers={suppliers}
          products={products}
          onClose={() => setShowCreateModal(false)}
          onSaved={loadData}
        />
      )}

      {viewingOrder && (
        <ViewPOModal
          order={viewingOrder}
          items={orderItems}
          onClose={() => setViewingOrder(null)}
          onUpdateStatus={(status) => updateOrderStatus(viewingOrder, status)}
          onRecordPayment={() => { setViewingOrder(null); openPaymentModal(viewingOrder); }}
          onEdit={() => { const o = viewingOrder; setViewingOrder(null); openEditModal(o); }}
          onCancel={() => { const o = viewingOrder; setViewingOrder(null); setCancellingOrder(o); }}
          onReceive={() => { setViewingOrder(null); router.push(`/purchases/grn?poId=${viewingOrder!.id}`); }}
        />
      )}

      {showPaymentModal && paymentOrder && (
        <RecordPOPaymentModal
          order={paymentOrder}
          onClose={() => { setShowPaymentModal(false); setPaymentOrder(null); }}
          onSaved={() => { setShowPaymentModal(false); setPaymentOrder(null); loadData(); }}
        />
      )}

      {editingOrder && (
        <EditPOModal
          order={editingOrder}
          suppliers={suppliers}
          products={products}
          onClose={() => setEditingOrder(null)}
          onSaved={() => { setEditingOrder(null); loadData(); }}
        />
      )}

      {cancellingOrder && (
        <CancelPOConfirmModal
          order={cancellingOrder}
          onClose={() => setCancellingOrder(null)}
          onConfirm={() => cancelOrder(cancellingOrder)}
        />
      )}
    </div>
  );
}

function CreatePOModal({ suppliers, products, onClose, onSaved }: {
  suppliers: Supplier[];
  products: Product[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    supplier_id: '',
    order_date: new Date().toISOString().split('T')[0],
    expected_date: '',
    notes: '',
    reference: '',
    payment_type: 'credit' as 'credit' | 'partial' | 'full',
    amount_paid: 0,
    payment_method: 'bank_transfer' as PaymentMethod,
    payment_reference: '',
    cart_discount_percent: 0,
    extra_discount: 0,
  });
  const [items, setItems] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showAddSupplier, setShowAddSupplier] = useState(false);
  const [supplierList, setSupplierList] = useState(suppliers);
  const [paymentMethods, setPaymentMethods] = useState<{ code: string; name: string }[]>([]);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string; code: string }[]>([]);

  useEffect(() => {
    supabase.from('payment_methods').select('code, name').eq('is_active', true).order('sort_order')
      .then(({ data }) => { if (data) setPaymentMethods(data); });
    supabase.from('warehouses').select('id, name, code').eq('is_active', true).order('name')
      .then(({ data }) => { if (data) setWarehouses(data as any); });

    // Load bulk reminder products from sessionStorage
    const bulkProductsRaw = sessionStorage.getItem('bulkReminderProducts');
    const bulkReminderIdsRaw = sessionStorage.getItem('bulkReminderIds');
    if (bulkProductsRaw) {
      sessionStorage.removeItem('bulkReminderProducts');
      sessionStorage.removeItem('bulkReminderIds');
      (async () => {
      try {
        const productIds: string[] = JSON.parse(bulkProductsRaw);
        const reminderIds: string[] = bulkReminderIdsRaw ? JSON.parse(bulkReminderIdsRaw) : [];
        if (productIds.length > 0) {
          // Fetch product details and auto-add to items
          const { data: prods } = await supabase
            .from('products')
            .select('*, units:product_units(id, product_id, unit_name, unit_short, conversion_factor, is_base_unit, is_sale_unit, price, cost_price, is_active, sort_order)')
            .in('id', productIds);
          if (prods) {
            const newItems = prods.map((p: any) => {
              const units = (p.units || []).filter((u: any) => u.is_active);
              const multi = isMultiUnitEnabled(p);
              const defaultUnit = multi ? getDefaultSaleUnit(units) : null;
              const unitPrice = defaultUnit ? defaultUnit.cost_price : (p.cost_price || 0);
              const baseQty = defaultUnit ? convertToBaseUnit(1, defaultUnit) : 1;
              const defaultWarehouseId = warehouses.length > 0 ? (warehouses.find(w => (w as any).is_default)?.id || warehouses[0].id) : '';
              return {
                product_id: p.id,
                product_name: p.name,
                product_sku: p.sku,
                product_unit: p.unit,
                product_base_unit: p.base_unit,
                quantity: 1,
                unit_price: unitPrice,
                discount_percent: 0,
                selected_unit: defaultUnit,
                available_units: units,
                base_quantity: baseQty,
                cost_price: unitPrice,
                warehouse_id: defaultWarehouseId,
              };
            });
            setItems(newItems);
            if (reminderIds.length > 0) {
              setForm(f => ({ ...f, notes: `Bulk PO from ${reminderIds.length} purchase reminder(s)` }));
            }
          }
        }
      } catch (e) {
        console.error('Failed to parse bulk reminder products:', e);
      }
      })();
    }
  }, []);

  async function handleAddSupplier(newSupplierId: string) {
    const { data } = await supabase.from('suppliers').select('*').eq('id', newSupplierId).single();
    if (data) {
      setSupplierList([...supplierList, data as Supplier]);
      setForm({ ...form, supplier_id: newSupplierId });
    }
  }

  function addProductToItems(product: any) {
    const units = (product.units || []).filter((u: any) => u.is_active);
    const multi = isMultiUnitEnabled(product);
    const defaultUnit = multi ? getDefaultSaleUnit(units) : null;
    const unitPrice = defaultUnit ? defaultUnit.cost_price : (product.cost_price || 0);
    const baseQty = defaultUnit ? convertToBaseUnit(1, defaultUnit) : 1;

    // Deduplicate: if same product+unit+warehouse already exists, increment quantity
    const existingIdx = items.findIndex(it =>
      it.product_id === product.id &&
      (!defaultUnit || (it.selected_unit && it.selected_unit.id === defaultUnit.id)) &&
      it.warehouse_id === (warehouses.length > 0 ? (warehouses.find(w => (w as any).is_default)?.id || warehouses[0].id) : '')
    );
    if (existingIdx >= 0) {
      const updated = [...items];
      updated[existingIdx] = { ...updated[existingIdx], quantity: updated[existingIdx].quantity + 1 };
      setItems(updated);
      return;
    }

    // Pick default warehouse (first warehouse or the default one)
    const defaultWarehouseId = warehouses.length > 0 ? (warehouses.find(w => (w as any).is_default)?.id || warehouses[0].id) : '';

    setItems([...items, {
      product_id: product.id,
      product_name: product.name,
      product_sku: product.sku,
      product_unit: product.unit,
      product_base_unit: product.base_unit,
      quantity: 1,
      unit_price: unitPrice,
      discount_percent: 0,
      selected_unit: defaultUnit,
      available_units: units,
      base_quantity: baseQty,
      cost_price: unitPrice,
      warehouse_id: defaultWarehouseId,
    }]);
  }

  function updateItem(index: number, field: string, value: any) {
    const updated = [...items];
    if (field === 'selected_unit') {
      const unit = value as ProductUnit;
      updated[index] = { ...updated[index], selected_unit: unit, unit_price: unit.cost_price || unit.price, base_quantity: convertToBaseUnit(updated[index].quantity, unit), cost_price: unit.cost_price || 0 };
    } else if (field === 'quantity') {
      const qty = parseInt(value) || 1;
      const unit = updated[index].selected_unit;
      updated[index] = { ...updated[index], quantity: qty, base_quantity: unit ? convertToBaseUnit(qty, unit) : qty };
    } else if (field === 'discount_percent') {
      updated[index] = { ...updated[index], discount_percent: Math.min(100, Math.max(0, parseFloat(value) || 0)) };
    } else {
      (updated[index] as any)[field] = value;
    }
    setItems(updated);
  }

  function removeItem(index: number) {
    setItems(items.filter((_, i) => i !== index));
  }

  const subtotal = items.reduce((sum, item) => sum + (item.quantity * item.unit_price * (1 - item.discount_percent / 100)), 0);
  const cartDiscountAmount = (subtotal * (form.cart_discount_percent || 0)) / 100;
  const totalAmount = Math.max(0, subtotal - cartDiscountAmount - (form.extra_discount || 0));
  const amountPaid = form.payment_type === 'full' ? totalAmount : (form.payment_type === 'partial' ? form.amount_paid : 0);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!form.supplier_id) { setError('Please select a supplier'); return; }
    if (items.length === 0) { setError('Please add at least one item'); return; }
    if (form.payment_type === 'partial' && form.amount_paid <= 0) { setError('Please enter payment amount for partial payment'); return; }
    if (form.payment_type === 'partial' && form.amount_paid >= totalAmount) { setError('Partial payment must be less than total. Use "Full Payment" instead.'); return; }

    setSaving(true);
    setError('');

    const { data: poNum } = await supabase.rpc('generate_purchase_order_number');
    const poNumber = poNum || `PO-${Date.now().toString().slice(-6)}`;

    const { data: po, error: poError } = await supabase
      .from('purchase_orders')
      .insert({
        po_number: poNumber,
        supplier_id: form.supplier_id,
        order_date: form.order_date,
        expected_date: form.expected_date || null,
        subtotal,
        cart_discount_percent: form.cart_discount_percent || 0,
        extra_discount: form.extra_discount || 0,
        discount_amount: cartDiscountAmount,
        total_amount: totalAmount,
        amount_paid: 0,
        status: 'draft',
        notes: form.notes || null,
        reference: form.reference || null,
      })
      .select()
      .single();

    if (poError) { setError(poError.message); setSaving(false); return; }

    const poItems = items.map(item => {
      const discount = (item.unit_price * item.quantity * item.discount_percent) / 100;
      return {
        purchase_order_id: po.id,
        product_id: item.product_id,
        quantity: item.quantity,
        unit_cost: item.unit_price,
        discount_percent: item.discount_percent || 0,
        subtotal: item.quantity * item.unit_price - discount,
        unit_name: item.selected_unit?.unit_name || item.product_unit || null,
        unit_conversion_factor: item.selected_unit?.conversion_factor || null,
        base_quantity: item.base_quantity,
        warehouse_id: item.warehouse_id || null,
      };
    });

    const { error: itemsError } = await supabase.from('purchase_order_items').insert(poItems);
    if (itemsError) { setError(itemsError.message); setSaving(false); return; }

    // Record payment if full or partial
    if (amountPaid > 0) {
      const { data: poPayNum } = await supabase.rpc('generate_purchase_payment_number');
      const paymentNumber = poPayNum || `POPAY-${Date.now().toString().slice(-6)}`;
      await supabase.from('payments').insert({
        payment_number: paymentNumber,
        payment_type: 'made',
        reference_type: 'purchase_order',
        reference_id: po.id,
        supplier_id: form.supplier_id,
        amount: amountPaid,
        payment_method: form.payment_method,
        payment_date: form.order_date,
        reference_number: form.payment_reference || null,
        notes: form.payment_type === 'full' ? 'Full payment at order time' : 'Partial payment at order time',
        payment_for: 'supplier_payment',
      });

      const { data: currentSupplier } = await supabase
        .from('suppliers')
        .select('outstanding_balance, total_purchases')
        .eq('id', form.supplier_id)
        .single();

      if (currentSupplier) {
        await supabase
          .from('suppliers')
          .update({
            outstanding_balance: (currentSupplier.outstanding_balance || 0) + (totalAmount - amountPaid),
            total_purchases: (currentSupplier.total_purchases || 0) + totalAmount,
            updated_at: new Date().toISOString()
          })
          .eq('id', form.supplier_id);
      }
    }

    toast({ title: 'Success', description: 'Purchase order created successfully' });
    onSaved();
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-white z-10">
          <h2 className="text-base font-bold">Create Purchase Order</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSave} className="p-6 space-y-4">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}

          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <label className="block text-xs font-medium mb-1">Supplier *</label>
              <div className="flex gap-2">
                <SupplierSearchInput
                  onSelect={(s) => setForm({ ...form, supplier_id: s.id })}
                  selectedName={supplierList.find(s => s.id === form.supplier_id)?.name}
                  placeholder="Search supplier by name or code..."
                  className="flex-1"
                />
                <button
                  type="button"
                  onClick={() => setShowAddSupplier(true)}
                  className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-3 py-2 text-sm font-medium transition shrink-0"
                >
                  <UserPlus className="w-4 h-4" /> New
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium mb-1">Order Date</label>
                <input type="date" value={form.order_date} onChange={e => setForm({ ...form, order_date: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Expected</label>
                <input type="date" value={form.expected_date} onChange={e => setForm({ ...form, expected_date: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Reference</label>
            <input type="text" value={form.reference} onChange={e => setForm({ ...form, reference: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" placeholder="Reference person or PO ref" />
          </div>

          <div>
            <label className="block text-xs font-medium mb-2">Add Products</label>
            <ProductSearchInput
              onSelect={addProductToItems}
              placeholder="Search product by name or SKU..."
              showStock
              className="w-full"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium">Line Items ({items.length})</label>
            </div>
            {items.length > 0 ? (
              <div className="border border-border rounded-lg overflow-hidden">
                <table className="w-full">
                  <thead className="bg-muted/40">
                    <tr>
                      <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Product</th>
                      <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2 w-32">Warehouse</th>
                      <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2 w-20">Qty</th>
                      <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2 w-28">Cost</th>
                      <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2 w-20">Disc%</th>
                      <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2 w-28">Total</th>
                      <th className="w-8"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {items.map((item, index) => (
                      <tr key={index}>
                        <td className="px-3 py-2">
                          <p className="text-sm font-medium text-foreground">{item.product_name}</p>
                          <p className="text-[10px] text-muted-foreground">{item.product_sku}</p>
                          {item.available_units && item.available_units.length > 0 && item.selected_unit && (
                            <select
                              value={item.selected_unit.id}
                              onChange={e => {
                                const unit = item.available_units?.find((u: any) => u.id === e.target.value);
                                if (unit) updateItem(index, 'selected_unit', unit);
                              }}
                              className="mt-1 w-full border border-blue-200 bg-blue-50 text-blue-700 rounded px-2 py-1 text-xs focus:outline-none"
                            >
                              {item.available_units.map((u: any) => <option key={u.id} value={u.id}>{u.unit_name} - {formatCurrency(u.cost_price || u.price)}</option>)}
                            </select>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={item.warehouse_id || ''}
                            onChange={e => updateItem(index, 'warehouse_id', e.target.value)}
                            className="w-full border border-border rounded px-2 py-1 text-xs focus:outline-none"
                          >
                            <option value="">Default</option>
                            {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2"><input type="number" min="1" value={item.quantity} onChange={e => updateItem(index, 'quantity', e.target.value)} className="w-full border border-border rounded px-2 py-1 text-sm text-right focus:outline-none" /></td>
                        <td className="px-3 py-2"><input type="number" min="0" step="0.01" value={item.unit_price} onChange={e => updateItem(index, 'unit_price', parseFloat(e.target.value) || 0)} className="w-full border border-border rounded px-2 py-1 text-sm text-right focus:outline-none" /></td>
                        <td className="px-3 py-2"><input type="number" min="0" max="100" value={item.discount_percent} onChange={e => updateItem(index, 'discount_percent', e.target.value)} className="w-full border border-border rounded px-2 py-1 text-sm text-right focus:outline-none" /></td>
                        <td className="px-3 py-2 text-right text-sm font-semibold">{formatCurrency(item.quantity * item.unit_price * (1 - item.discount_percent / 100))}</td>
                        <td className="px-2 py-2"><button type="button" onClick={() => removeItem(index)} className="text-red-500 hover:text-red-600"><Trash2 className="w-4 h-4" /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="border border-dashed border-border rounded-lg p-6 text-center text-sm text-muted-foreground">
                Search and select products above to add them to this purchase order.
              </div>
            )}
          </div>

          <div className="flex justify-end bg-muted/30 rounded-lg p-3">
            <div className="text-right w-full max-w-xs space-y-2">
              <div className="flex justify-between items-center"><p className="text-xs text-muted-foreground">Subtotal</p><p className="text-sm font-semibold text-foreground">{formatCurrency(subtotal)}</p></div>
              <div className="flex justify-between items-center gap-2">
                <label className="text-xs text-muted-foreground">Cart Discount %</label>
                <input type="number" min="0" max="100" step="0.5" value={form.cart_discount_percent || 0} onChange={e => setForm({ ...form, cart_discount_percent: Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)) })} className="w-24 border border-border rounded-lg px-2 py-1 text-sm text-right focus:outline-none" />
              </div>
              {(form.cart_discount_percent || 0) > 0 && (
                <div className="flex justify-between text-xs text-red-500"><span>Cart Discount ({form.cart_discount_percent}%)</span><span>-{formatCurrency(cartDiscountAmount)}</span></div>
              )}
              <div className="flex justify-between items-center gap-2">
                <label className="text-xs text-muted-foreground">Extra Discount ৳</label>
                <input type="number" min="0" step="0.01" value={form.extra_discount || 0} onChange={e => setForm({ ...form, extra_discount: parseFloat(e.target.value) || 0 })} className="w-24 border border-border rounded-lg px-2 py-1 text-sm text-right focus:outline-none" />
              </div>
              {(form.extra_discount || 0) > 0 && (
                <div className="flex justify-between text-xs text-red-500"><span>Extra Discount</span><span>-{formatCurrency(form.extra_discount || 0)}</span></div>
              )}
              <div className="flex justify-between items-center pt-1 border-t border-border"><p className="text-xs font-medium text-muted-foreground">Total</p><p className="text-lg font-bold text-foreground">{formatCurrency(totalAmount)}</p></div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Notes</label>
            <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" placeholder="Internal notes for this purchase order..." />
          </div>

          <div className="border border-border rounded-lg p-4">
            <label className="block text-xs font-medium mb-3">Payment Type *</label>
            <div className="grid grid-cols-3 gap-3">
              <button
                type="button"
                onClick={() => setForm({ ...form, payment_type: 'credit', amount_paid: 0 })}
                className={`p-3 border rounded-lg text-center transition ${form.payment_type === 'credit' ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-border hover:border-gray-300'}`}
              >
                <CreditCard className="w-5 h-5 mx-auto mb-1" />
                <p className="text-xs font-medium">Full Credit</p>
                <p className="text-[10px] text-muted-foreground">Pay later</p>
              </button>
              <button
                type="button"
                onClick={() => setForm({ ...form, payment_type: 'partial' })}
                className={`p-3 border rounded-lg text-center transition ${form.payment_type === 'partial' ? 'border-amber-600 bg-amber-50 text-amber-700' : 'border-border hover:border-gray-300'}`}
              >
                <DollarSign className="w-5 h-5 mx-auto mb-1" />
                <p className="text-xs font-medium">Partial</p>
                <p className="text-[10px] text-muted-foreground">Pay some now</p>
              </button>
              <button
                type="button"
                onClick={() => setForm({ ...form, payment_type: 'full', amount_paid: totalAmount })}
                className={`p-3 border rounded-lg text-center transition ${form.payment_type === 'full' ? 'border-green-600 bg-green-50 text-green-700' : 'border-border hover:border-gray-300'}`}
              >
                <CheckCircle className="w-5 h-5 mx-auto mb-1" />
                <p className="text-xs font-medium">Full Payment</p>
                <p className="text-[10px] text-muted-foreground">Pay all now</p>
              </button>
            </div>
            {(form.payment_type === 'partial' || form.payment_type === 'full') && (
              <div className="mt-4 p-3 bg-green-50 rounded-lg border border-green-200 space-y-3">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium mb-1 text-green-800">Payment Method *</label>
                    <select
                      value={form.payment_method}
                      onChange={e => setForm({ ...form, payment_method: e.target.value as PaymentMethod })}
                      className="w-full border border-green-300 bg-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500/20"
                    >
                      {paymentMethods.length > 0 ? (
                        paymentMethods.map(pm => (
                          <option key={pm.code} value={pm.code}>{pm.name}</option>
                        ))
                      ) : (
                        <>
                          <option value="cash">Cash</option>
                          <option value="bank_transfer">Bank Transfer</option>
                          <option value="card">Card (Credit/Debit)</option>
                          <option value="cheque">Cheque</option>
                        </>
                      )}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1 text-green-800">Reference / Transaction ID</label>
                    <input
                      type="text"
                      value={form.payment_reference}
                      onChange={e => setForm({ ...form, payment_reference: e.target.value })}
                      className="w-full border border-green-300 bg-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500/20"
                      placeholder="e.g. Cheque #, Transaction ID"
                    />
                  </div>
                </div>
                {form.payment_type === 'partial' && (
                  <div>
                    <label className="block text-xs font-medium mb-1 text-green-800">Payment Amount *</label>
                    <input
                      type="number"
                      min="0.01"
                      max={totalAmount - 0.01}
                      step="0.01"
                      value={form.amount_paid}
                      onChange={e => setForm({ ...form, amount_paid: parseFloat(e.target.value) || 0 })}
                      className="w-full border border-green-300 bg-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500/20"
                      placeholder={`Enter amount (Max: ${formatCurrency(totalAmount)})`}
                    />
                    <p className="text-xs text-green-700 mt-1 font-medium">
                      Balance Due After Payment: {formatCurrency(totalAmount - form.amount_paid)}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60">
              {saving ? 'Creating...' : 'Create Purchase Order'}
            </button>
          </div>

          {showAddSupplier && (
            <AddSupplierModal
              onClose={() => setShowAddSupplier(false)}
              onSaved={(id) => { handleAddSupplier(id); setShowAddSupplier(false); }}
            />
          )}
        </form>
      </div>
    </div>
  );
}

function ViewPOModal({ order, items, onClose, onUpdateStatus, onRecordPayment, onEdit, onCancel, onReceive }: {
  order: PurchaseOrderWithSupplier;
  items: any[];
  onClose: () => void;
  onUpdateStatus: (status: PurchaseOrderStatus) => void;
  onRecordPayment: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onReceive: () => void;
}) {
  const cfg = statusConfig[order.status as PurchaseOrderStatus] || statusConfig.draft;
  const isCancelled = order.status === 'cancelled';
  const balance = isCancelled ? 0 : Number(order.total_amount) - Number(order.amount_paid);
  const canEdit = order.status === 'draft' || order.status === 'approved';
  const [returns, setReturns] = useState<{ return_number: string; total_amount: number; status: string; return_date: string }[]>([]);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('purchase_returns')
        .select('return_number, total_amount, status, return_date')
        .eq('purchase_order_id', order.id)
        .order('created_at', { ascending: false });
      setReturns(data || []);
    })();
  }, [order.id]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="print-modal bg-white rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-white">
          <h2 className="text-base font-bold">Purchase Order {order.po_number}</h2>
          <div className="no-print flex items-center gap-2">
            {canEdit && (
              <button onClick={onEdit} className="flex items-center gap-1 px-3 py-1.5 border border-border rounded-lg text-sm hover:bg-blue-50 hover:text-blue-600 transition">
                <Pencil className="w-4 h-4" />Edit
              </button>
            )}
            {canEdit && (
              <button onClick={onCancel} className="flex items-center gap-1 px-3 py-1.5 border border-border rounded-lg text-sm hover:bg-red-50 hover:text-red-600 transition">
                <Ban className="w-4 h-4" />Cancel
              </button>
            )}
            <button onClick={() => window.print()} className="flex items-center gap-1 px-3 py-1.5 border border-border rounded-lg text-sm hover:bg-muted transition">
              <Printer className="w-4 h-4" />Print
            </button>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
          </div>
        </div>

        <div className="p-6 space-y-6">
          <div className="flex justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Supplier</p>
              <p className="font-semibold text-foreground">{order.supplier?.name || '-'}</p>
              <p className="text-sm text-muted-foreground">{order.supplier?.phone || '-'}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Status</p>
              <span className={`badge-status ${cfg.bg} ${cfg.color}`}>{cfg.label}</span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 py-3 border-y border-border">
            <div>
              <p className="text-xs text-muted-foreground">Order Date</p>
              <p className="text-sm font-medium">{formatDate(order.order_date)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Expected Date</p>
              <p className="text-sm font-medium">{order.expected_date ? formatDate(order.expected_date) : '-'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Amount Paid</p>
              <p className="text-sm font-medium text-green-600">{formatCurrency(order.amount_paid)}</p>
            </div>
          </div>

          <div>
            <p className="text-xs font-medium mb-2">Items</p>
            <div className="border border-border rounded-lg overflow-hidden">
              <table className="w-full">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Product</th>
                    <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2">Qty</th>
                    <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2">Cost</th>
                    <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2">Disc%</th>
                    <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.length === 0 ? (
                    <tr><td colSpan={5} className="px-3 py-4 text-center text-xs text-muted-foreground">No items</td></tr>
                  ) : items.map((item, idx) => (
                    <tr key={idx}>
                      <td className="px-3 py-2 text-sm">
                        <p className="font-medium text-foreground">{item.product?.name || '-'}</p>
                        {item.product?.sku && <p className="text-[10px] text-muted-foreground">{item.product.sku}</p>}
                        {item.unit_name && <p className="text-[10px] text-blue-600">{item.unit_name}</p>}
                      </td>
                      <td className="px-3 py-2 text-sm text-right">{item.quantity}</td>
                      <td className="px-3 py-2 text-sm text-right">{formatCurrency(item.unit_cost || item.unit_price)}</td>
                      <td className="px-3 py-2 text-sm text-right">{item.discount_percent ? `${item.discount_percent}%` : '-'}</td>
                      <td className="px-3 py-2 text-sm text-right font-semibold">{formatCurrency(item.subtotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex justify-end bg-muted/30 rounded-lg p-4">
            <div className="w-56 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Subtotal</span>
                <span>{formatCurrency(Number(order.subtotal) || Number(order.total_amount))}</span>
              </div>
              {(Number(order.discount_amount) || 0) > 0 && (
                <div className="flex justify-between text-sm text-red-500">
                  <span>Discount</span>
                  <span>-{formatCurrency(order.discount_amount)}</span>
                </div>
              )}
              {(Number((order as any).extra_discount) || 0) > 0 && (
                <div className="flex justify-between text-sm text-red-500">
                  <span>Extra Discount</span>
                  <span>-{formatCurrency((order as any).extra_discount)}</span>
                </div>
              )}
              <div className="flex justify-between text-sm font-semibold border-t border-border pt-1">
                <span>Total</span>
                <span>{formatCurrency(order.total_amount)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Paid</span>
                <span className="text-green-600">{formatCurrency(order.amount_paid)}</span>
              </div>
              {returns.length > 0 && (
                <div className="flex justify-between text-sm text-purple-600">
                  <span>Returns ({returns.length})</span>
                  <span>-{formatCurrency(returns.reduce((s, r) => s + Number(r.total_amount), 0))}</span>
                </div>
              )}
              <div className="flex justify-between font-bold text-base border-t border-border pt-2">
                <span>Balance</span>
                <span className={isCancelled ? 'text-muted-foreground' : balance > 0 ? 'text-red-600' : 'text-green-600'}>
                  {isCancelled ? 'Cancelled' : formatCurrency(balance)}
                </span>
              </div>
            </div>
          </div>

          {returns.length > 0 && (
            <div>
              <p className="text-xs font-medium mb-2 text-purple-700">Purchase Returns</p>
              <div className="border border-purple-200 rounded-lg overflow-hidden">
                <table className="w-full">
                  <thead className="bg-purple-50">
                    <tr>
                      <th className="text-left text-xs font-semibold text-purple-700 px-3 py-2">Return #</th>
                      <th className="text-left text-xs font-semibold text-purple-700 px-3 py-2">Date</th>
                      <th className="text-right text-xs font-semibold text-purple-700 px-3 py-2">Amount</th>
                      <th className="text-left text-xs font-semibold text-purple-700 px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-purple-100">
                    {returns.map((r, idx) => (
                      <tr key={idx}>
                        <td className="px-3 py-2 text-sm font-medium text-purple-700">{r.return_number}</td>
                        <td className="px-3 py-2 text-sm text-muted-foreground">{formatDate(r.return_date)}</td>
                        <td className="px-3 py-2 text-sm text-right font-semibold">{formatCurrency(r.total_amount)}</td>
                        <td className="px-3 py-2"><span className="badge-status bg-purple-100 text-purple-700">{r.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {order.status === 'draft' && (
            <div className="no-print flex gap-2">
              <button onClick={() => onUpdateStatus('approved')} className="flex-1 flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 text-white py-2 rounded-lg text-sm font-semibold transition">
                <CheckCircle className="w-4 h-4" />Approve Order
              </button>
            </div>
          )}

          {order.status === 'approved' && (
            <div className="no-print flex gap-2">
              <button onClick={() => onReceive()} className="flex-1 flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white py-2 rounded-lg text-sm font-semibold transition">
                <Truck className="w-4 h-4" />Receive (Open GRN)
              </button>
            </div>
          )}

          {balance > 0 && (order.status === 'approved' || order.status === 'received' || order.status === 'partially_received') && (
            <div className="no-print flex gap-2 pt-2 border-t border-border">
              <button onClick={onRecordPayment} className="flex-1 flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 text-white py-2 rounded-lg text-sm font-semibold transition">
                <CreditCard className="w-4 h-4" />Record Payment
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RecordPOPaymentModal({ order, onClose, onSaved }: { order: PurchaseOrderWithSupplier; onClose: () => void; onSaved: () => void }) {
  const balance = Number(order.total_amount) - Number(order.amount_paid);
  const [form, setForm] = useState({
    amount: balance,
    payment_method: 'bank_transfer' as PaymentMethod,
    payment_date: new Date().toISOString().split('T')[0],
    reference_number: '',
    notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [paymentMethods, setPaymentMethods] = useState<{ code: string; name: string }[]>([]);

  useEffect(() => {
    supabase.from('payment_methods').select('code, name').eq('is_active', true).order('sort_order')
      .then(({ data }) => { if (data && data.length > 0) setPaymentMethods(data); });
  }, []);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (form.amount <= 0) { setError('Amount must be greater than 0'); return; }
    if (form.amount > balance) { setError(`Amount cannot exceed balance (${formatCurrency(balance)})`); return; }

    setSaving(true);
    setError('');

    const { data: poPayNum2 } = await supabase.rpc('generate_purchase_payment_number');
    const paymentNumber = poPayNum2 || `POPAY-${Date.now().toString().slice(-6)}`;

    const { error: payError } = await supabase.from('payments').insert({
      payment_number: paymentNumber,
      payment_type: 'made',
      reference_type: 'purchase_order',
      reference_id: order.id,
      supplier_id: order.supplier_id,
      amount: form.amount,
      payment_method: form.payment_method,
      payment_date: form.payment_date,
      reference_number: form.reference_number || null,
      notes: form.notes || null,
      payment_for: 'supplier_payment',
    });

    if (payError) { setError(payError.message); setSaving(false); return; }

    // amount_paid is updated automatically by the payment_po_amount_paid_trigger

    // Update supplier outstanding balance
    const { data: currentSupplier } = await supabase
      .from('suppliers')
      .select('outstanding_balance, total_purchases')
      .eq('id', order.supplier_id)
      .single();

    if (currentSupplier) {
      await supabase
        .from('suppliers')
        .update({
          outstanding_balance: Math.max(0, (currentSupplier.outstanding_balance || 0) - form.amount),
          updated_at: new Date().toISOString()
        })
        .eq('id', order.supplier_id);
    }

    toast({ title: 'Success', description: `Payment of ${formatCurrency(form.amount)} recorded` });
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-bold">Record Payment to Supplier</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}

          <div className="bg-muted/30 rounded-lg p-3 flex justify-between">
            <span className="text-sm text-muted-foreground">Outstanding Balance</span>
            <span className="text-sm font-bold text-red-600">{formatCurrency(balance)}</span>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Payment Amount *</label>
            <input type="number" min="0.01" max={balance} step="0.01" value={form.amount} onChange={e => setForm({ ...form, amount: parseFloat(e.target.value) || 0 })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Payment Method *</label>
            <select required value={form.payment_method} onChange={e => setForm({ ...form, payment_method: e.target.value as PaymentMethod })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none">
              {paymentMethods.length > 0 ? (
                paymentMethods.map(pm => <option key={pm.code} value={pm.code}>{pm.name}</option>)
              ) : (
                <>
                  <option value="bank_transfer">Bank Transfer</option>
                  <option value="cash">Cash</option>
                  <option value="bkash">bKash</option>
                  <option value="nagad">Nagad</option>
                  <option value="card">Card</option>
                  <option value="cheque">Cheque</option>
                </>
              )}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Payment Date</label>
            <input type="date" value={form.payment_date} onChange={e => setForm({ ...form, payment_date: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Reference Number</label>
            <input type="text" value={form.reference_number} onChange={e => setForm({ ...form, reference_number: e.target.value })} placeholder="Transaction ID, cheque no." className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Notes</label>
            <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60">
              {saving ? 'Recording...' : 'Record Payment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditPOModal({ order, suppliers, products, onClose, onSaved }: {
  order: PurchaseOrderWithSupplier;
  suppliers: Supplier[];
  products: Product[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    supplier_id: order.supplier_id,
    order_date: order.order_date,
    expected_date: order.expected_date || '',
    notes: (order as any).notes || '',
    reference: (order as any).reference || '',
    cart_discount_percent: Number((order as any).cart_discount_percent) || 0,
    extra_discount: Number((order as any).extra_discount) || 0,
  });
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [supplierList, setSupplierList] = useState(suppliers);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string; code: string }[]>([]);

  useEffect(() => {
    (async () => {
      const [itemsRes, whRes] = await Promise.all([
        supabase
          .from('purchase_order_items')
          .select('*, product:products(name, sku, unit, base_unit, enable_multi_unit, units:product_units(id, product_id, unit_name, unit_short, conversion_factor, is_base_unit, is_sale_unit, price, cost_price, is_active, sort_order))')
          .eq('purchase_order_id', order.id),
        supabase.from('warehouses').select('id, name, code').eq('is_active', true).order('name'),
      ]);
      setWarehouses((whRes.data as any) || []);
      setItems((itemsRes.data || []).map((it: any) => {
        const prod = Array.isArray(it.product) ? it.product[0] : it.product;
        const units = Array.isArray(it.units) ? it.units : (prod?.units || []);
        const selectedUnit = units.find((u: any) => u.unit_name === it.unit_name) || null;
        return {
          id: it.id,
          product_id: it.product_id,
          product_name: prod?.name || '—',
          product_sku: prod?.sku || '',
          product_unit: prod?.unit,
          product_base_unit: prod?.base_unit,
          quantity: Number(it.quantity),
          unit_price: Number(it.unit_cost),
          discount_percent: Number(it.discount_percent) || 0,
          selected_unit: selectedUnit,
          available_units: units.filter((u: any) => u.is_active),
          base_quantity: Number(it.base_quantity) || Number(it.quantity),
          cost_price: selectedUnit?.cost_price || 0,
          warehouse_id: it.warehouse_id || '',
        };
      }));
      setLoading(false);
    })();
  }, [order.id]);

  function updateItem(index: number, field: string, value: any) {
    const updated = [...items];
    if (field === 'selected_unit') {
      const unit = value as ProductUnit;
      updated[index] = { ...updated[index], selected_unit: unit, unit_price: unit.cost_price || unit.price, base_quantity: convertToBaseUnit(updated[index].quantity, unit), cost_price: unit.cost_price || 0 };
    } else if (field === 'quantity') {
      const qty = parseInt(value) || 1;
      const unit = updated[index].selected_unit;
      updated[index] = { ...updated[index], quantity: qty, base_quantity: unit ? convertToBaseUnit(qty, unit) : qty };
    } else if (field === 'discount_percent') {
      updated[index] = { ...updated[index], discount_percent: Math.min(100, Math.max(0, parseFloat(value) || 0)) };
    } else {
      (updated[index] as any)[field] = value;
    }
    setItems(updated);
  }

  function removeItem(index: number) {
    setItems(items.filter((_, i) => i !== index));
  }

  function addProductToItems(product: any) {
    const units = (product.units || []).filter((u: any) => u.is_active);
    const multi = isMultiUnitEnabled(product);
    const defaultUnit = multi ? getDefaultSaleUnit(units) : null;
    const unitPrice = defaultUnit ? defaultUnit.cost_price : (product.cost_price || 0);
    const baseQty = defaultUnit ? convertToBaseUnit(1, defaultUnit) : 1;
    const defaultWhId = warehouses.length > 0 ? (warehouses.find(w => (w as any).is_default)?.id || warehouses[0].id) : '';

    const existingIdx = items.findIndex(it =>
      it.product_id === product.id &&
      (!defaultUnit || (it.selected_unit && it.selected_unit.id === defaultUnit.id)) &&
      it.warehouse_id === defaultWhId
    );
    if (existingIdx >= 0) {
      const updated = [...items];
      updated[existingIdx] = { ...updated[existingIdx], quantity: updated[existingIdx].quantity + 1 };
      setItems(updated);
      return;
    }

    setItems([...items, {
      product_id: product.id,
      product_name: product.name,
      product_sku: product.sku,
      product_unit: product.unit,
      product_base_unit: product.base_unit,
      quantity: 1,
      unit_price: unitPrice,
      discount_percent: 0,
      selected_unit: defaultUnit,
      available_units: units,
      base_quantity: baseQty,
      cost_price: unitPrice,
      warehouse_id: defaultWhId,
    }]);
  }

  const subtotal = items.reduce((sum, item) => sum + (item.quantity * item.unit_price * (1 - item.discount_percent / 100)), 0);
  const cartDiscountAmount = (subtotal * (form.cart_discount_percent || 0)) / 100;
  const totalAmount = Math.max(0, subtotal - cartDiscountAmount - (form.extra_discount || 0));

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!form.supplier_id) { setError('Please select a supplier'); return; }
    if (items.length === 0) { setError('Please add at least one item'); return; }

    setSaving(true);
    setError('');

    const oldTotal = Number(order.total_amount);
    const oldPaid = Number(order.amount_paid);
    const totalDiff = totalAmount - oldTotal;

    const { error: poError } = await supabase
      .from('purchase_orders')
      .update({
        supplier_id: form.supplier_id,
        order_date: form.order_date,
        expected_date: form.expected_date || null,
        subtotal,
        cart_discount_percent: form.cart_discount_percent || 0,
        extra_discount: form.extra_discount || 0,
        discount_amount: cartDiscountAmount,
        total_amount: totalAmount,
        notes: form.notes || null,
        reference: form.reference || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', order.id);

    if (poError) { setError(poError.message); setSaving(false); return; }

    await supabase.from('purchase_order_items').delete().eq('purchase_order_id', order.id);
    const poItems = items.map(item => {
      const discount = (item.unit_price * item.quantity * item.discount_percent) / 100;
      return {
        purchase_order_id: order.id,
        product_id: item.product_id,
        quantity: item.quantity,
        unit_cost: item.unit_price,
        discount_percent: item.discount_percent || 0,
        subtotal: item.quantity * item.unit_price - discount,
        unit_name: item.selected_unit?.unit_name || item.product_unit || null,
        unit_conversion_factor: item.selected_unit?.conversion_factor || null,
        base_quantity: item.base_quantity,
        warehouse_id: item.warehouse_id || null,
      };
    });
    const { error: itemsError } = await supabase.from('purchase_order_items').insert(poItems);
    if (itemsError) { setError(itemsError.message); setSaving(false); return; }

    if (totalDiff !== 0) {
      // Cap amount_paid at the new total to prevent negative balances
      const cappedPaid = Math.min(oldPaid, totalAmount);
      const overpaymentRefund = oldPaid - cappedPaid;

      const newUnpaid = totalAmount - cappedPaid;
      const oldUnpaid = oldTotal - oldPaid;
      const balanceAdjustment = newUnpaid - oldUnpaid;

      // Update PO amount_paid if it needs capping
      if (overpaymentRefund > 0) {
        await supabase
          .from('purchase_orders')
          .update({ amount_paid: cappedPaid })
          .eq('id', order.id);
      }

      const { data: supplier } = await supabase
        .from('suppliers')
        .select('outstanding_balance, total_purchases')
        .eq('id', form.supplier_id)
        .single();

      if (supplier) {
        await supabase
          .from('suppliers')
          .update({
            outstanding_balance: Math.max(0, (supplier.outstanding_balance || 0) + balanceAdjustment - overpaymentRefund),
            total_purchases: Math.max(0, (supplier.total_purchases || 0) + totalDiff),
            updated_at: new Date().toISOString(),
          })
          .eq('id', form.supplier_id);
      }
    }

    toast({ title: 'Success', description: `Purchase order ${order.po_number} updated` });
    onSaved();
    onClose();
  }

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-2xl w-full max-w-3xl shadow-2xl p-8 text-center text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-3xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-white z-10">
          <div>
            <h2 className="text-base font-bold">Edit Purchase Order</h2>
            <p className="text-xs text-muted-foreground">{order.po_number}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSave} className="p-6 space-y-4">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}

          {(order.status === 'approved') && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
              This order is already approved. Editing will update the order details and adjust the supplier balance if the total changes.
            </div>
          )}

          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <label className="block text-xs font-medium mb-1">Supplier *</label>
              <SupplierSearchInput
                onSelect={(s) => setForm({ ...form, supplier_id: s.id })}
                selectedName={supplierList.find(s => s.id === form.supplier_id)?.name}
                placeholder="Search supplier..."
                className="w-full"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium mb-1">Order Date</label>
                <input type="date" value={form.order_date} onChange={e => setForm({ ...form, order_date: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Expected</label>
                <input type="date" value={form.expected_date} onChange={e => setForm({ ...form, expected_date: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Reference</label>
            <input type="text" value={form.reference} onChange={e => setForm({ ...form, reference: e.target.value })} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" placeholder="Reference person or PO ref" />
          </div>

          <div>
            <label className="block text-xs font-medium mb-2">Add Products</label>
            <ProductSearchInput
              onSelect={addProductToItems}
              placeholder="Search product by name or SKU..."
              showStock
              className="w-full"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium">Line Items ({items.length})</label>
            </div>
            {items.length > 0 ? (
              <div className="border border-border rounded-lg overflow-hidden">
                <table className="w-full">
                  <thead className="bg-muted/40">
                    <tr>
                      <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2">Product</th>
                      <th className="text-left text-xs font-semibold text-muted-foreground px-3 py-2 w-32">Warehouse</th>
                      <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2 w-20">Qty</th>
                      <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2 w-28">Cost</th>
                      <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2 w-20">Disc%</th>
                      <th className="text-right text-xs font-semibold text-muted-foreground px-3 py-2 w-28">Total</th>
                      <th className="w-8"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {items.map((item, index) => (
                      <tr key={index}>
                        <td className="px-3 py-2">
                          <p className="text-sm font-medium text-foreground">{item.product_name}</p>
                          <p className="text-[10px] text-muted-foreground">{item.product_sku}</p>
                          {item.available_units && item.available_units.length > 0 && item.selected_unit && (
                            <select
                              value={item.selected_unit.id}
                              onChange={e => {
                                const unit = item.available_units?.find((u: any) => u.id === e.target.value);
                                if (unit) updateItem(index, 'selected_unit', unit);
                              }}
                              className="mt-1 w-full border border-blue-200 bg-blue-50 text-blue-700 rounded px-2 py-1 text-xs focus:outline-none"
                            >
                              {item.available_units.map((u: any) => <option key={u.id} value={u.id}>{u.unit_name} - {formatCurrency(u.cost_price || u.price)}</option>)}
                            </select>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={item.warehouse_id || ''}
                            onChange={e => updateItem(index, 'warehouse_id', e.target.value)}
                            className="w-full border border-border rounded px-2 py-1 text-xs focus:outline-none"
                          >
                            <option value="">Default</option>
                            {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2"><input type="number" min="1" value={item.quantity} onChange={e => updateItem(index, 'quantity', e.target.value)} className="w-full border border-border rounded px-2 py-1 text-sm text-right focus:outline-none" /></td>
                        <td className="px-3 py-2"><input type="number" min="0" step="0.01" value={item.unit_price} onChange={e => updateItem(index, 'unit_price', parseFloat(e.target.value) || 0)} className="w-full border border-border rounded px-2 py-1 text-sm text-right focus:outline-none" /></td>
                        <td className="px-3 py-2"><input type="number" min="0" max="100" value={item.discount_percent} onChange={e => updateItem(index, 'discount_percent', e.target.value)} className="w-full border border-border rounded px-2 py-1 text-sm text-right focus:outline-none" /></td>
                        <td className="px-3 py-2 text-right text-sm font-semibold">{formatCurrency(item.quantity * item.unit_price * (1 - item.discount_percent / 100))}</td>
                        <td className="px-2 py-2"><button type="button" onClick={() => removeItem(index)} className="text-red-500 hover:text-red-600"><Trash2 className="w-4 h-4" /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="border border-dashed border-border rounded-lg p-6 text-center text-sm text-muted-foreground">
                Search and select products above to add them to this purchase order.
              </div>
            )}
          </div>

          <div className="flex justify-end bg-muted/30 rounded-lg p-3">
            <div className="text-right w-full max-w-xs space-y-2">
              <div className="flex justify-between items-center"><p className="text-xs text-muted-foreground">Subtotal</p><p className="text-sm font-semibold text-foreground">{formatCurrency(subtotal)}</p></div>
              <div className="flex justify-between items-center gap-2">
                <label className="text-xs text-muted-foreground">Cart Discount %</label>
                <input type="number" min="0" max="100" step="0.5" value={form.cart_discount_percent || 0} onChange={e => setForm({ ...form, cart_discount_percent: Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)) })} className="w-24 border border-border rounded-lg px-2 py-1 text-sm text-right focus:outline-none" />
              </div>
              {(form.cart_discount_percent || 0) > 0 && (
                <div className="flex justify-between text-xs text-red-500"><span>Cart Discount ({form.cart_discount_percent}%)</span><span>-{formatCurrency(cartDiscountAmount)}</span></div>
              )}
              <div className="flex justify-between items-center gap-2">
                <label className="text-xs text-muted-foreground">Extra Discount ৳</label>
                <input type="number" min="0" step="0.01" value={form.extra_discount || 0} onChange={e => setForm({ ...form, extra_discount: parseFloat(e.target.value) || 0 })} className="w-24 border border-border rounded-lg px-2 py-1 text-sm text-right focus:outline-none" />
              </div>
              {(form.extra_discount || 0) > 0 && (
                <div className="flex justify-between text-xs text-red-500"><span>Extra Discount</span><span>-{formatCurrency(form.extra_discount || 0)}</span></div>
              )}
              <div className="flex justify-between items-center pt-1 border-t border-border">
                <p className="text-xs font-medium text-muted-foreground">New Total</p>
                <p className="text-lg font-bold text-foreground">{formatCurrency(totalAmount)}</p>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Previous Total</span>
                <span>{formatCurrency(Number(order.total_amount))}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Already Paid</span>
                <span className="text-green-600">{formatCurrency(Number(order.amount_paid))}</span>
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Notes</label>
            <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60">
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CancelPOConfirmModal({ order, onClose, onConfirm }: {
  order: PurchaseOrderWithSupplier;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const balance = Number(order.total_amount) - Number(order.amount_paid);
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" style={{ zIndex: 60 }}>
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-bold">Cancel Purchase Order</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm text-foreground">
            Are you sure you want to cancel purchase order <span className="font-semibold">{order.po_number}</span>?
          </p>
          <div className="bg-muted/30 rounded-lg p-3 space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Supplier</span><span className="font-medium">{order.supplier?.name || '-'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Total Amount</span><span className="font-medium">{formatCurrency(order.total_amount)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Amount Paid</span><span className="font-medium text-green-600">{formatCurrency(order.amount_paid)}</span></div>
            {balance > 0 && (
              <div className="flex justify-between"><span className="text-muted-foreground">Unpaid Balance</span><span className="font-medium text-red-600">{formatCurrency(balance)}</span></div>
            )}
          </div>
          {balance > 0 && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
              The unpaid balance of {formatCurrency(balance)} will be removed from the supplier&apos;s outstanding payables.
            </div>
          )}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Close</button>
            <button onClick={onConfirm} className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold transition">
              Yes, Cancel Order
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AddSupplierModal({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const [form, setForm] = useState({
    name: '',
    code: `SUP-${Date.now().toString().slice(-4)}`,
    phone: '',
    email: '',
    company_name: '',
    city: '',
    address: '',
    credit_limit: '0',
    credit_days: '30',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name) { setError('Supplier name is required'); return; }

    setSaving(true);
    setError('');

    const { data, error: insertError } = await supabase
      .from('suppliers')
      .insert({
        name: form.name,
        code: form.code,
        phone: form.phone || null,
        email: form.email || null,
        company_name: form.company_name || null,
        city: form.city || null,
        address: form.address || null,
        credit_limit: Number(form.credit_limit),
        credit_days: Number(form.credit_days),
        country: 'Bangladesh',
      })
      .select('id')
      .single();

    if (insertError) {
      setError(insertError.message);
      setSaving(false);
      return;
    }

    toast({ title: 'Success', description: 'Supplier created successfully' });
    onSaved(data.id);
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" style={{ zIndex: 60 }}>
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-bold">Add New Supplier</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">{error}</div>}

          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-xs font-medium mb-1">Supplier Name *</label>
              <input
                required
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Code</label>
              <input
                value={form.code}
                onChange={e => setForm({ ...form, code: e.target.value })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Phone</label>
              <input
                value={form.phone}
                onChange={e => setForm({ ...form, phone: e.target.value })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={e => setForm({ ...form, email: e.target.value })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">City</label>
              <input
                value={form.city}
                onChange={e => setForm({ ...form, city: e.target.value })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-60">
              {saving ? 'Creating...' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
