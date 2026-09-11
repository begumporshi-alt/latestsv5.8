/**
 * Pending-rows overlay: documents created offline appear in list views
 * immediately.
 *
 * The replica query engine (lib/offline/replica-query.ts) answers offline
 * page reads from the local replica tables — but a document queued in the
 * outbox doesn't exist there until the sync applies it and the replicator
 * refreshes. Without this overlay, an offline-created invoice is invisible in
 * the sales list for that window, which reads as data loss to a new user.
 *
 * pendingRowsFor(table) derives provisional rows from the queued outbox
 * payloads (unsealed in memory, cached briefly) and the engine merges them
 * into every read of the tables the op touches — filters, ordering, embeds
 * and .eq('id', …) detail fetches all work, so `customer:customers(...)`
 * resolves even for an offline-created customer.
 *
 * Rows carry the client-generated id wherever the server handler honors one
 * (invoice/product/customer/po/quotation/delivery/… creates), so a SECOND
 * queued operation referencing them — a payment against an offline invoice —
 * references the id the server will actually store. Rows for ops whose ids
 * are server-generated (payments, returns, GRNs) use synthesized display ids;
 * nothing references those later. Every row carries __pending: true.
 *
 * On enqueue, the per-query read caches for the affected tables are dropped
 * (invalidateQueryCachesForOp) — otherwise an offline page read would serve
 * its stale cached list and hide the new document.
 */
import { getDB } from './db'
import { getUserKey, unseal } from './crypto'
import { resolveUserId } from './session'

/** Statuses whose queued work has NOT landed in the replica yet. */
const ACTIVE_STATUSES = new Set(['pending', 'syncing', 'failed', 'conflict'])

/** op → tables the overlay derives provisional rows for. */
export const OP_TABLES: Record<string, string[]> = {
  'invoice.create': ['invoices', 'invoice_items'],
  'payment.create': ['payments'],
  'po.payment': ['payments'],
  'sales_return.create': ['sales_returns'],
  'advance.receive': ['customer_advances'],
  'store_credit.issue': ['customer_store_credits'],
  'expense.create': ['journal_entries', 'journal_lines'],
  'supplier.create': ['suppliers'],
  'customer.create': ['customers'],
  'po.create': ['purchase_orders', 'purchase_order_items'],
  'grn.receive': ['goods_receipt_notes'],
  'purchase_return.create': ['purchase_returns', 'purchase_return_items'],
  'quotation.create': ['quotations', 'quotation_items'],
  'delivery.create': ['deliveries'],
  'warehouse.create': ['warehouses'],
  'project.create': ['projects'],
  'customer_note.create': ['customer_notes'],
  'stock_transfer.create': ['stock_movements'],
}

interface PendingRow {
  table: string
  row: Record<string, any>
}

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v))

/** Per-op row derivation. `itemId`/`createdAt` come from the outbox item. */
function deriveRows(op: string, p: Record<string, any>, itemId: string, createdAt: number): PendingRow[] {
  const now = new Date(createdAt).toISOString()
  const synthId = (suffix: string) => `pending-${itemId}-${suffix}`
  const out: PendingRow[] = []
  const base = { created_at: now, updated_at: now, __pending: true }

  switch (op) {
    case 'invoice.create': {
      const id = p.id || synthId('inv')
      out.push({
        table: 'invoices',
        row: {
          ...base,
          id,
          invoice_number: p.temp_number || `INV-OFF-${String(createdAt).slice(-6)}`,
          customer_id: p.customer_id ?? null,
          invoice_date: p.invoice_date ?? null,
          due_date: p.due_date ?? null,
          subtotal: num(p.subtotal),
          discount_amount: num(p.discount_amount),
          cart_discount_percent: num(p.cart_discount_percent),
          extra_discount: num(p.extra_discount),
          tax_amount: num(p.tax_amount),
          shipping_cost: num(p.shipping_cost),
          total_amount: num(p.total_amount),
          amount_paid: num(p.amount_paid),
          status: p.status || 'draft',
          is_pos: p.is_pos !== false,
          notes: str(p.notes),
          reference: str(p.reference),
        },
      })
      const items = Array.isArray(p.items) ? p.items : []
      items.forEach((it: any, i: number) => {
        out.push({
          table: 'invoice_items',
          row: {
            ...base,
            id: synthId(`item${i}`),
            invoice_id: id,
            product_id: it.product_id ?? null,
            quantity: num(it.quantity),
            unit_price: num(it.unit_price),
            cost_price: num(it.cost_price),
            discount_percent: num(it.discount_percent),
            tax_rate: num(it.tax_rate),
            subtotal: num(it.subtotal),
            unit_name: str(it.unit_name),
            unit_conversion_factor: it.unit_conversion_factor ?? null,
            base_quantity: num(it.base_quantity, num(it.quantity)),
            warehouse_id: str(it.warehouse_id),
            description: str(it.description),
          },
        })
      })
      break
    }
    case 'payment.create':
    case 'po.payment': {
      const isPo = op === 'po.payment'
      out.push({
        table: 'payments',
        row: {
          ...base,
          id: synthId('pay'),
          payment_number: p.temp_number || `${isPo ? 'POPAY' : 'PAY'}-OFF-${String(createdAt).slice(-6)}`,
          payment_type: isPo ? 'made' : 'received',
          reference_type: isPo ? 'purchase_order' : 'invoice',
          reference_id: (isPo ? p.po_id : p.invoice_id) ?? null,
          customer_id: p.customer_id ?? null,
          supplier_id: p.supplier_id ?? null,
          amount: num(p.amount),
          bad_debt_amount: num(p.bad_debt_amount),
          wht_amount: num(p.wht_amount),
          payment_method: p.payment_method || 'cash',
          payment_date: p.payment_date ?? null,
          reference_number: str(p.reference_number),
          notes: str(p.notes),
          payment_for: p.payment_for ?? null,
          is_reversed: false,
        },
      })
      break
    }
    case 'sales_return.create':
      out.push({
        table: 'sales_returns',
        row: {
          ...base,
          id: synthId('ret'),
          return_number: p.temp_number || `SR-OFF-${String(createdAt).slice(-6)}`,
          invoice_id: p.invoice_id ?? null,
          customer_id: p.customer_id ?? null,
          refund_method: p.refund_method || 'cash',
          refund_amount: num(p.refund_amount),
          status: 'completed',
        },
      })
      break
    case 'advance.receive':
      out.push({
        table: 'customer_advances',
        row: {
          ...base,
          id: synthId('adv'),
          advance_number: p.temp_number || `ADV-OFF-${String(createdAt).slice(-6)}`,
          customer_id: p.customer_id ?? null,
          amount: num(p.amount),
          balance: num(p.amount),
          status: 'active',
          payment_method: p.payment_method || 'cash',
          payment_date: p.payment_date ?? null,
          reference_number: str(p.reference_number),
          notes: str(p.notes),
        },
      })
      break
    case 'store_credit.issue':
      out.push({
        table: 'customer_store_credits',
        row: {
          ...base,
          id: p.id || synthId('sc'),
          credit_number: p.temp_number || `SC-OFF-${String(createdAt).slice(-6)}`,
          customer_id: p.customer_id ?? null,
          amount: num(p.amount),
          balance: num(p.amount),
          status: 'active',
          notes: str(p.notes),
          expires_at: str(p.expires_at),
        },
      })
      break
    case 'expense.create': {
      const id = synthId('je')
      const amount = num(p.amount)
      out.push({
        table: 'journal_entries',
        row: {
          ...base,
          id,
          entry_number: p.temp_number || `JE-OFF-${String(createdAt).slice(-6)}`,
          entry_date: p.date ?? null,
          description: p.description || 'Expense payment',
          reference_type: 'manual',
          reference_id: null,
          total_debit: amount,
          total_credit: amount,
          is_posted: true,
        },
      })
      const lines = [
        { account_id: p.expense_account_id ?? null, debit: amount, credit: 0 },
        { account_id: p.paid_from ?? null, debit: 0, credit: amount },
      ]
      lines.forEach((l, i) => {
        out.push({
          table: 'journal_lines',
          row: {
            ...base,
            id: synthId(`jl${i}`),
            journal_entry_id: id,
            account_id: l.account_id,
            description: p.description || 'Expense payment',
            debit: l.debit,
            credit: l.credit,
            sort_order: i,
          },
        })
      })
      break
    }
    case 'supplier.create': {
      const d = p.data || {}
      out.push({
        table: 'suppliers',
        row: {
          ...base,
          id: p.id || synthId('sup'),
          name: d.name ?? null,
          code: str(d.code),
          phone: str(d.phone),
          email: str(d.email),
          mobile: str(d.mobile),
          company_name: str(d.company_name),
          city: str(d.city),
          address: str(d.address),
          credit_limit: num(d.credit_limit),
          credit_days: num(d.credit_days),
          rating: d.rating ?? null,
          is_active: d.is_active !== false,
          country: d.country || 'Bangladesh',
          outstanding_balance: 0,
          total_purchases: 0,
        },
      })
      break
    }
    case 'customer.create': {
      const d = p.data || {}
      out.push({
        table: 'customers',
        row: {
          ...base,
          id: p.id || synthId('cust'),
          code: str(d.code),
          name: d.name ?? null,
          phone: str(d.phone),
          email: str(d.email),
          address: str(d.address),
          type: d.type || 'retail',
          country: d.country || 'Bangladesh',
          is_active: d.is_active !== false,
          credit_limit: num(d.credit_limit),
          credit_days: num(d.credit_days),
          outstanding_balance: 0,
          total_purchases: 0,
          loyalty_points: num(d.loyalty_points),
          discount_percent: num(d.discount_percent),
        },
      })
      break
    }
    case 'po.create': {
      const id = p.id || synthId('po')
      out.push({
        table: 'purchase_orders',
        row: {
          ...base,
          id,
          po_number: p.temp_number || `PO-OFF-${String(createdAt).slice(-6)}`,
          supplier_id: p.supplier_id ?? null,
          order_date: p.order_date ?? null,
          expected_date: p.expected_date ?? null,
          subtotal: num(p.subtotal),
          cart_discount_percent: num(p.cart_discount_percent),
          extra_discount: num(p.extra_discount),
          discount_amount: num(p.discount_amount),
          total_amount: num(p.total_amount),
          amount_paid: num(p.amount_paid),
          status: 'draft',
          notes: str(p.notes),
          reference: str(p.reference),
        },
      })
      const items = Array.isArray(p.items) ? p.items : []
      items.forEach((it: any, i: number) => {
        out.push({
          table: 'purchase_order_items',
          row: {
            ...base,
            id: synthId(`item${i}`),
            purchase_order_id: id,
            product_id: it.product_id ?? null,
            quantity: num(it.quantity),
            unit_cost: num(it.unit_cost),
            discount_percent: num(it.discount_percent),
            subtotal: num(it.subtotal),
            unit_name: str(it.unit_name),
            unit_conversion_factor: it.unit_conversion_factor ?? null,
            base_quantity: num(it.base_quantity, num(it.quantity)),
            warehouse_id: str(it.warehouse_id),
            received_quantity: 0,
          },
        })
      })
      break
    }
    case 'grn.receive':
      out.push({
        table: 'goods_receipt_notes',
        row: {
          ...base,
          id: synthId('grn'),
          grn_number: p.temp_number || `GRN-OFF-${String(createdAt).slice(-6)}`,
          supplier_id: p.supplier_id ?? null,
          purchase_order_id: p.purchase_order_id ?? null,
          warehouse_id: p.warehouse_id ?? null,
          notes: str(p.notes),
        },
      })
      break
    case 'purchase_return.create': {
      const id = p.id || synthId('pret')
      out.push({
        table: 'purchase_returns',
        row: {
          ...base,
          id,
          return_number: p.return_number || p.temp_number || `PRET-OFF-${String(createdAt).slice(-6)}`,
          purchase_order_id: p.purchase_order_id ?? null,
          supplier_id: p.supplier_id ?? null,
          warehouse_id: p.warehouse_id ?? null,
          return_date: p.return_date ?? null,
          total_amount: num(p.total_amount),
          status: 'completed',
        },
      })
      const items = Array.isArray(p.items) ? p.items : []
      items.forEach((it: any, i: number) => {
        out.push({
          table: 'purchase_return_items',
          row: {
            ...base,
            id: synthId(`item${i}`),
            purchase_return_id: id,
            product_id: it.product_id ?? null,
            quantity: num(it.quantity),
            unit_cost: num(it.unit_cost),
            subtotal: num(it.subtotal),
            reason: it.reason || 'other',
          },
        })
      })
      break
    }
    case 'quotation.create': {
      const id = p.id || synthId('qt')
      out.push({
        table: 'quotations',
        row: {
          ...base,
          id,
          quote_number: p.temp_number || `QT-OFF-${String(createdAt).slice(-6)}`,
          customer_id: p.customer_id ?? null,
          issue_date: p.issue_date ?? null,
          expiry_date: p.expiry_date ?? null,
          subtotal: num(p.subtotal),
          cart_discount_percent: num(p.cart_discount_percent),
          extra_discount: num(p.extra_discount),
          discount_amount: num(p.discount_amount),
          tax_amount: num(p.tax_amount),
          shipping_cost: num(p.shipping_cost),
          total_amount: num(p.total_amount),
          status: 'draft',
          notes: str(p.notes),
          reference: str(p.reference),
        },
      })
      const items = Array.isArray(p.items) ? p.items : []
      items.forEach((it: any, i: number) => {
        out.push({
          table: 'quotation_items',
          row: {
            ...base,
            id: synthId(`item${i}`),
            quotation_id: id,
            product_id: it.product_id ?? null,
            quantity: num(it.quantity),
            unit_price: num(it.unit_price),
            discount_percent: num(it.discount_percent),
            tax_rate: num(it.tax_rate),
            subtotal: num(it.subtotal),
            unit_name: str(it.unit_name),
            unit_conversion_factor: it.unit_conversion_factor ?? null,
            base_quantity: num(it.base_quantity, num(it.quantity)),
            warehouse_id: str(it.warehouse_id),
          },
        })
      })
      break
    }
    case 'delivery.create':
      out.push({
        table: 'deliveries',
        row: {
          ...base,
          id: p.id || synthId('dlv'),
          delivery_number: p.temp_number || `DLV-OFF-${String(createdAt).slice(-6)}`,
          customer_id: p.customer_id ?? null,
          invoice_id: p.invoice_id ?? null,
          delivery_date: p.delivery_date ?? null,
          delivery_address: str(p.delivery_address),
          delivery_city: str(p.delivery_city),
          vehicle_number: str(p.vehicle_number),
          notes: str(p.notes),
          status: 'pending',
        },
      })
      break
    case 'warehouse.create': {
      const d = p.data || {}
      out.push({
        table: 'warehouses',
        row: {
          ...base,
          id: p.id || synthId('wh'),
          name: d.name ?? null,
          code: str(d.code),
          address: str(d.address),
          city: str(d.city),
          is_default: d.is_default === true,
          is_active: d.is_active !== false,
        },
      })
      break
    }
    case 'project.create': {
      const d = p.data || {}
      out.push({
        table: 'projects',
        row: {
          ...base,
          id: p.id || synthId('prj'),
          name: d.name ?? null,
          project_number: str(d.project_number),
          customer_id: d.customer_id ?? null,
          status: d.status || 'planning',
          priority: d.priority || 'medium',
          start_date: d.start_date ?? null,
          end_date: d.end_date ?? null,
          estimated_budget: d.estimated_budget ?? null,
          actual_cost: num(d.actual_cost),
          revenue: num(d.revenue),
          progress_percent: num(d.progress_percent),
          location: str(d.location),
          description: str(d.description),
        },
      })
      break
    }
    case 'customer_note.create':
      out.push({
        table: 'customer_notes',
        row: {
          ...base,
          id: p.id || synthId('note'),
          customer_id: p.customer_id ?? null,
          note: p.note ?? null,
          note_type: p.note_type || 'general',
        },
      })
      break
    case 'stock_transfer.create': {
      const id = p.id || synthId('trf')
      const number = p.transfer_number || `TRF-OFF-${String(createdAt).slice(-6)}`
      const movements = [
        { warehouse_id: p.from_warehouse_id, movement_type: 'transfer_out', quantity: -num(p.quantity) },
        { warehouse_id: p.to_warehouse_id, movement_type: 'transfer_in', quantity: num(p.quantity) },
      ]
      movements.forEach((m, i) => {
        out.push({
          table: 'stock_movements',
          row: {
            ...base,
            id: synthId(`mv${i}`),
            product_id: p.product_id ?? null,
            warehouse_id: m.warehouse_id ?? null,
            movement_type: m.movement_type,
            quantity: m.quantity,
            unit_cost: num(p.unit_cost),
            reference_type: 'transfer',
            reference_id: id,
            reference_number: number,
            notes: str(p.notes),
          },
        })
      })
      break
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Caches                                                              */
/* ------------------------------------------------------------------ */

const PENDING_TTL = 5_000
let tableCache = new Map<string, { at: number; rows: any[] }>()
let payloadCache = new Map<string, { at: number; payload: Record<string, any> | null }>()
let changeToken = 0

/** Drop all overlay caches — called when the outbox changes. */
export function resetPendingCaches(): void {
  tableCache = new Map()
  payloadCache = new Map()
  changeToken += 1
}

async function unsealItemPayload(item: { id: string; payload: unknown }): Promise<Record<string, any> | null> {
  const hit = payloadCache.get(item.id)
  if (hit && Date.now() - hit.at < PENDING_TTL) return hit.payload
  let payload: Record<string, any> | null = null
  try {
    const userId = await resolveUserId()
    if (userId) {
      const key = await getUserKey(userId)
      payload = await unseal<Record<string, any>>(key, item.payload as never)
    }
  } catch {
    payload = null
  }
  payloadCache.set(item.id, { at: Date.now(), payload })
  return payload
}

/**
 * Provisional rows for `table` derived from active outbox items. Empty when
 * offline storage is unavailable or nothing is queued.
 */
export async function pendingRowsFor(table: string): Promise<any[]> {
  try {
    if (typeof window === 'undefined') return []
    const hit = tableCache.get(table)
    if (hit && Date.now() - hit.at < PENDING_TTL) return hit.rows
    const token = changeToken
    const items = (await getDB().outbox.toArray()).filter(
      (i: any) => ACTIVE_STATUSES.has(i.status) && OP_TABLES[i.op],
    )
    const rows: any[] = []
    for (const item of items) {
      const payload = await unsealItemPayload(item)
      if (!payload) continue
      for (const derived of deriveRows(item.op, payload, item.id, item.createdAt)) {
        if (derived.table === table) rows.push(derived.row)
      }
    }
    if (token !== changeToken) return rows // outbox changed mid-read — caller re-reads soon
    tableCache.set(table, { at: Date.now(), rows })
    return rows
  } catch {
    return []
  }
}

/**
 * Drop the wrapper's per-query read caches for the tables an op touches, so
 * offline page reads re-run through the replica engine and pick up the new
 * pending rows instead of serving the pre-enqueue cached list.
 */
export async function invalidateQueryCachesForOp(op: string): Promise<void> {
  try {
    if (typeof window === 'undefined') return
    const tables = OP_TABLES[op]
    if (!tables || tables.length === 0) return
    const userId = await resolveUserId()
    if (!userId) return
    const db = getDB()
    for (const table of tables) {
      await db.cache.where('key').startsWith(`${userId}:q:from:${table}:`).delete()
    }
  } catch {
    // best-effort — a stale list refreshes on the next outbox change
  }
}
