/**
 * Pending-rows overlay: documents created or edited offline appear in list
 * views immediately.
 *
 * The replica query engine (lib/offline/replica-query.ts) answers offline
 * page reads from the local replica tables — but work queued in the outbox
 * doesn't exist there until the sync applies it and the replicator
 * refreshes. Without this overlay, an offline-created invoice is invisible
 * in the sales list and an offline status change doesn't show — both read
 * as data loss or stuck state to a new user.
 *
 * Every active outbox item derives EFFECTS:
 *   row           — a provisional row appended to its table (creates)
 *   patch         — fields applied to an existing (real or pending) row by
 *                   id; the patch may be a function of the row so derived
 *                   values (amount_paid after a payment, advance balance
 *                   after an application) stay consistent
 *   delete        — remove a row by id (offline deletes)
 *   deleteParent  — remove child rows by parent (quotation items)
 *   replaceParent — swap a pending document's derived child rows (edit of
 *                   an offline-created PO/quotation replaces its items)
 *
 * Effects are applied in queue order (createdAt ASC), so create → payment →
 * status chains compose. pendingOverlayFor(table) projects everything
 * relevant to one table; the engine merges rows, applies patches to both
 * real and pending rows, and filters deletes.
 *
 * Created rows carry the client-generated id wherever the server handler
 * honors one, so a SECOND queued operation referencing them — a payment
 * against an offline invoice — references the id the server will store.
 * Rows for ops whose ids are server-generated (payments, returns, GRNs)
 * use synthesized display ids; nothing references those later, and the
 * expenses page blocks editing queued expenses for that reason. Every row
 * carries __pending: true.
 *
 * On enqueue, the per-query read caches for the affected tables are dropped
 * (invalidateQueryCachesForOp) — otherwise an offline page read would serve
 * its stale cached list and hide the change.
 */
import { getDB } from './db'
import { getUserKey, unseal } from './crypto'
import { resolveUserId } from './session'

/** Statuses whose queued work has NOT landed in the replica yet. */
const ACTIVE_STATUSES = new Set(['pending', 'syncing', 'failed', 'conflict'])

/** op → tables the overlay derives rows/patches/deletes for (also drives cache invalidation). */
export const OP_TABLES: Record<string, string[]> = {
  'invoice.create': ['invoices', 'invoice_items'],
  'payment.create': ['payments', 'invoices'],
  'invoice.status': ['invoices'],
  'invoice.cancel': ['invoices'],
  'sales_return.create': ['sales_returns'],
  'advance.receive': ['customer_advances'],
  'advance.apply': ['customer_advances', 'customer_advance_applications', 'invoices'],
  'advance.refund': ['customer_advances', 'customer_advance_refunds'],
  'store_credit.issue': ['customer_store_credits'],
  'store_credit.expire': ['customer_store_credits'],
  'expense.create': ['journal_entries', 'journal_lines'],
  'supplier.create': ['suppliers'],
  'supplier.update': ['suppliers'],
  'customer.create': ['customers'],
  'po.create': ['purchase_orders', 'purchase_order_items'],
  'po.update': ['purchase_orders', 'purchase_order_items'],
  'po.status': ['purchase_orders'],
  'po.cancel': ['purchase_orders'],
  'po.payment': ['payments', 'purchase_orders'],
  'grn.receive': ['goods_receipt_notes'],
  'purchase_return.create': ['purchase_returns', 'purchase_return_items'],
  'quotation.create': ['quotations', 'quotation_items'],
  'quotation.update': ['quotations', 'quotation_items'],
  'quotation.status': ['quotations'],
  'quotation.delete': ['quotations', 'quotation_items'],
  'quotation.convert': ['quotations'],
  'delivery.create': ['deliveries'],
  'delivery.update': ['deliveries'],
  'delivery.status': ['deliveries'],
  'warehouse.create': ['warehouses'],
  'warehouse.update': ['warehouses'],
  'project.create': ['projects'],
  'project.update': ['projects'],
  'product.status': ['products'],
  'customer_note.create': ['customer_notes'],
  'customer_note.delete': ['customer_notes'],
  'stock_transfer.create': ['stock_movements'],
}

type Patch = Record<string, any> | ((row: any) => Record<string, any>)

type Effect =
  | { kind: 'row'; table: string; row: Record<string, any> }
  | { kind: 'patch'; table: string; id: string; patch: Patch }
  | { kind: 'delete'; table: string; id: string }
  | { kind: 'deleteParent'; table: string; parentColumn: string; parentId: string }
  | { kind: 'replaceParent'; table: string; parentColumn: string; parentId: string; rows: Record<string, any>[] }

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v))

/** Per-op effect derivation. `itemId`/`createdAt` come from the outbox item. */
function deriveEffects(op: string, p: Record<string, any>, itemId: string, createdAt: number): Effect[] {
  const now = new Date(createdAt).toISOString()
  const synthId = (suffix: string) => `pending-${itemId}-${suffix}`
  const out: Effect[] = []
  const stamp = (row: Record<string, any>) => ({ created_at: now, updated_at: now, __pending: true, ...row })

  switch (op) {
    case 'invoice.create': {
      const id = p.id || synthId('inv')
      out.push({
        kind: 'row',
        table: 'invoices',
        row: stamp({
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
        }),
      })
      const items = Array.isArray(p.items) ? p.items : []
      items.forEach((it: any, i: number) => {
        out.push({
          kind: 'row',
          table: 'invoice_items',
          row: stamp({
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
          }),
        })
      })
      break
    }
    case 'payment.create': {
      out.push({
        kind: 'row',
        table: 'payments',
        row: stamp({
          id: synthId('pay'),
          payment_number: p.temp_number || `PAY-OFF-${String(createdAt).slice(-6)}`,
          payment_type: 'received',
          reference_type: 'invoice',
          reference_id: p.invoice_id ?? null,
          customer_id: p.customer_id ?? null,
          supplier_id: null,
          amount: num(p.amount),
          bad_debt_amount: num(p.bad_debt_amount),
          wht_amount: 0,
          payment_method: p.payment_method || 'cash',
          payment_date: p.payment_date ?? null,
          reference_number: str(p.reference_number),
          notes: str(p.notes),
          payment_for: p.payment_for ?? null,
          is_reversed: false,
        }),
      })
      // The invoice's paid amount and status advance immediately.
      const paid = num(p.amount)
      const bad = num(p.bad_debt_amount)
      if (p.invoice_id) {
        out.push({
          kind: 'patch',
          table: 'invoices',
          id: String(p.invoice_id),
          patch: (row: any) => {
            const amountPaid = num(row.amount_paid) + paid
            const balance = num(row.total_amount) - amountPaid - (num(row.bad_debt_amount) + bad)
            return {
              amount_paid: amountPaid,
              bad_debt_amount: num(row.bad_debt_amount) + bad,
              status: balance <= 0.01 ? 'paid' : 'partially_paid',
            }
          },
        })
      }
      break
    }
    case 'po.payment': {
      out.push({
        kind: 'row',
        table: 'payments',
        row: stamp({
          id: synthId('pay'),
          payment_number: p.temp_number || `POPAY-OFF-${String(createdAt).slice(-6)}`,
          payment_type: 'made',
          reference_type: 'purchase_order',
          reference_id: p.po_id ?? null,
          customer_id: null,
          supplier_id: p.supplier_id ?? null,
          amount: num(p.amount),
          bad_debt_amount: 0,
          wht_amount: num(p.wht_amount),
          payment_method: p.payment_method || 'cash',
          payment_date: p.payment_date ?? null,
          reference_number: str(p.reference_number),
          notes: str(p.notes),
          payment_for: 'supplier_payment',
          is_reversed: false,
        }),
      })
      if (p.po_id) {
        out.push({
          kind: 'patch',
          table: 'purchase_orders',
          id: String(p.po_id),
          patch: (row: any) => ({ amount_paid: num(row.amount_paid) + num(p.amount) }),
        })
      }
      break
    }
    case 'invoice.status':
      if (p.invoice_id) {
        out.push({ kind: 'patch', table: 'invoices', id: String(p.invoice_id), patch: { status: p.status } })
      }
      break
    case 'invoice.cancel':
      if (p.invoice_id) {
        out.push({ kind: 'patch', table: 'invoices', id: String(p.invoice_id), patch: { status: 'cancelled' } })
      }
      break
    case 'sales_return.create':
      out.push({
        kind: 'row',
        table: 'sales_returns',
        row: stamp({
          id: synthId('ret'),
          return_number: p.temp_number || `SR-OFF-${String(createdAt).slice(-6)}`,
          invoice_id: p.invoice_id ?? null,
          customer_id: p.customer_id ?? null,
          refund_method: p.refund_method || 'cash',
          refund_amount: num(p.refund_amount),
          status: 'completed',
        }),
      })
      break
    case 'advance.receive':
      out.push({
        kind: 'row',
        table: 'customer_advances',
        row: stamp({
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
        }),
      })
      break
    case 'advance.apply': {
      out.push({
        kind: 'row',
        table: 'customer_advance_applications',
        row: stamp({
          id: synthId('app'),
          advance_id: p.advance_id ?? null,
          customer_id: p.customer_id ?? null,
          invoice_id: p.invoice_id ?? null,
          amount: num(p.amount),
          notes: 'Advance applied to invoice',
        }),
      })
      const applied = num(p.amount)
      if (p.advance_id) {
        out.push({
          kind: 'patch',
          table: 'customer_advances',
          id: String(p.advance_id),
          patch: (row: any) => {
            const balance = num(row.balance) - applied
            return { balance, status: balance <= 0.001 ? 'applied' : 'active' }
          },
        })
      }
      if (p.invoice_id) {
        out.push({
          kind: 'patch',
          table: 'invoices',
          id: String(p.invoice_id),
          patch: (row: any) => {
            const amountPaid = num(row.amount_paid) + applied
            const balance = num(row.total_amount) - amountPaid - num(row.bad_debt_amount)
            return { amount_paid: amountPaid, status: balance <= 0.001 ? 'paid' : 'partially_paid' }
          },
        })
      }
      break
    }
    case 'advance.refund':
      out.push({
        kind: 'row',
        table: 'customer_advance_refunds',
        row: stamp({
          id: synthId('ref'),
          advance_id: p.advance_id ?? null,
          customer_id: p.customer_id ?? null,
          amount: num(p.amount),
          refund_method: p.refund_method || 'cash',
          refund_date: p.refund_date ?? null,
          reference_number: str(p.reference_number),
          notes: str(p.notes),
        }),
      })
      {
        const refunded = num(p.amount)
        if (p.advance_id) {
          out.push({
            kind: 'patch',
            table: 'customer_advances',
            id: String(p.advance_id),
            patch: (row: any) => {
              const balance = num(row.balance) - refunded
              return { balance, status: balance <= 0.001 ? 'refunded' : 'active' }
            },
          })
        }
      }
      break
    case 'store_credit.issue':
      out.push({
        kind: 'row',
        table: 'customer_store_credits',
        row: stamp({
          id: p.id || synthId('sc'),
          credit_number: p.temp_number || `SC-OFF-${String(createdAt).slice(-6)}`,
          customer_id: p.customer_id ?? null,
          amount: num(p.amount),
          balance: num(p.amount),
          status: 'active',
          notes: str(p.notes),
          expires_at: str(p.expires_at),
        }),
      })
      break
    case 'store_credit.expire':
      if (p.credit_id) {
        out.push({ kind: 'patch', table: 'customer_store_credits', id: String(p.credit_id), patch: { status: 'expired' } })
      }
      break
    case 'expense.create': {
      const id = synthId('je')
      const amount = num(p.amount)
      out.push({
        kind: 'row',
        table: 'journal_entries',
        row: stamp({
          id,
          entry_number: p.temp_number || `JE-OFF-${String(createdAt).slice(-6)}`,
          entry_date: p.date ?? null,
          description: p.description || 'Expense payment',
          reference_type: 'manual',
          reference_id: null,
          total_debit: amount,
          total_credit: amount,
          is_posted: true,
        }),
      })
      const lines = [
        { account_id: p.expense_account_id ?? null, debit: amount, credit: 0 },
        { account_id: p.paid_from ?? null, debit: 0, credit: amount },
      ]
      lines.forEach((l, i) => {
        out.push({
          kind: 'row',
          table: 'journal_lines',
          row: stamp({
            id: synthId(`jl${i}`),
            journal_entry_id: id,
            account_id: l.account_id,
            description: p.description || 'Expense payment',
            debit: l.debit,
            credit: l.credit,
            sort_order: i,
          }),
        })
      })
      break
    }
    case 'supplier.create': {
      const d = p.data || {}
      out.push({
        kind: 'row',
        table: 'suppliers',
        row: stamp({
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
        }),
      })
      break
    }
    case 'supplier.update':
      if (p.id) {
        out.push({ kind: 'patch', table: 'suppliers', id: String(p.id), patch: { ...(p.data || {}), updated_at: now } })
      }
      break
    case 'customer.create': {
      const d = p.data || {}
      out.push({
        kind: 'row',
        table: 'customers',
        row: stamp({
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
        }),
      })
      break
    }
    case 'po.create': {
      const id = p.id || synthId('po')
      out.push({
        kind: 'row',
        table: 'purchase_orders',
        row: stamp({
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
        }),
      })
      const items = Array.isArray(p.items) ? p.items : []
      items.forEach((it: any, i: number) => {
        out.push({
          kind: 'row',
          table: 'purchase_order_items',
          row: stamp({
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
          }),
        })
      })
      break
    }
    case 'po.update': {
      const id = p.id ? String(p.id) : null
      const total = num(p.total_amount)
      if (id) {
        out.push({
          kind: 'patch',
          table: 'purchase_orders',
          id,
          patch: (row: any) => ({
            supplier_id: p.supplier_id ?? row.supplier_id,
            order_date: p.order_date ?? row.order_date,
            expected_date: p.expected_date ?? null,
            subtotal: num(p.subtotal),
            cart_discount_percent: num(p.cart_discount_percent),
            extra_discount: num(p.extra_discount),
            discount_amount: num(p.discount_amount),
            total_amount: total,
            notes: str(p.notes),
            reference: str(p.reference),
            amount_paid: Math.min(num(row.amount_paid), total),
          }),
        })
        // An edit of an offline-created PO replaces its derived items.
        const items = Array.isArray(p.items) ? p.items : []
        out.push({
          kind: 'replaceParent',
          table: 'purchase_order_items',
          parentColumn: 'purchase_order_id',
          parentId: id,
          rows: items.map((it: any, i: number) =>
            stamp({
              id: synthId(`edit${i}`),
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
            }),
          ),
        })
      }
      break
    }
    case 'po.status':
      if (p.id) {
        out.push({ kind: 'patch', table: 'purchase_orders', id: String(p.id), patch: { status: p.status } })
      }
      break
    case 'po.cancel':
      if (p.id) {
        out.push({
          kind: 'patch',
          table: 'purchase_orders',
          id: String(p.id),
          patch: (row: any) => ({ status: 'cancelled', amount_paid: num(row.total_amount) }),
        })
      }
      break
    case 'grn.receive':
      out.push({
        kind: 'row',
        table: 'goods_receipt_notes',
        row: stamp({
          id: synthId('grn'),
          grn_number: p.temp_number || `GRN-OFF-${String(createdAt).slice(-6)}`,
          supplier_id: p.supplier_id ?? null,
          purchase_order_id: p.purchase_order_id ?? null,
          warehouse_id: p.warehouse_id ?? null,
          notes: str(p.notes),
        }),
      })
      break
    case 'purchase_return.create': {
      const id = p.id || synthId('pret')
      out.push({
        kind: 'row',
        table: 'purchase_returns',
        row: stamp({
          id,
          return_number: p.return_number || p.temp_number || `PRET-OFF-${String(createdAt).slice(-6)}`,
          purchase_order_id: p.purchase_order_id ?? null,
          supplier_id: p.supplier_id ?? null,
          warehouse_id: p.warehouse_id ?? null,
          return_date: p.return_date ?? null,
          total_amount: num(p.total_amount),
          status: 'completed',
        }),
      })
      const items = Array.isArray(p.items) ? p.items : []
      items.forEach((it: any, i: number) => {
        out.push({
          kind: 'row',
          table: 'purchase_return_items',
          row: stamp({
            id: synthId(`item${i}`),
            purchase_return_id: id,
            product_id: it.product_id ?? null,
            quantity: num(it.quantity),
            unit_cost: num(it.unit_cost),
            subtotal: num(it.subtotal),
            reason: it.reason || 'other',
          }),
        })
      })
      break
    }
    case 'quotation.create': {
      const id = p.id || synthId('qt')
      out.push({
        kind: 'row',
        table: 'quotations',
        row: stamp({
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
        }),
      })
      const items = Array.isArray(p.items) ? p.items : []
      items.forEach((it: any, i: number) => {
        out.push({
          kind: 'row',
          table: 'quotation_items',
          row: stamp({
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
          }),
        })
      })
      break
    }
    case 'quotation.update': {
      const id = p.id ? String(p.id) : null
      if (id) {
        out.push({
          kind: 'patch',
          table: 'quotations',
          id,
          patch: {
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
            notes: str(p.notes),
            reference: str(p.reference),
            updated_at: now,
          },
        })
        const items = Array.isArray(p.items) ? p.items : []
        out.push({
          kind: 'replaceParent',
          table: 'quotation_items',
          parentColumn: 'quotation_id',
          parentId: id,
          rows: items.map((it: any, i: number) =>
            stamp({
              id: synthId(`edit${i}`),
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
            }),
          ),
        })
      }
      break
    }
    case 'quotation.status':
      if (p.id) {
        out.push({ kind: 'patch', table: 'quotations', id: String(p.id), patch: { status: p.status } })
      }
      break
    case 'quotation.delete':
      if (p.id) {
        out.push({ kind: 'delete', table: 'quotations', id: String(p.id) })
        out.push({ kind: 'deleteParent', table: 'quotation_items', parentColumn: 'quotation_id', parentId: String(p.id) })
      }
      break
    case 'quotation.convert':
      if (p.quotation_id) {
        out.push({ kind: 'patch', table: 'quotations', id: String(p.quotation_id), patch: { status: 'converted' } })
      }
      break
    case 'delivery.create':
      out.push({
        kind: 'row',
        table: 'deliveries',
        row: stamp({
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
        }),
      })
      break
    case 'delivery.update':
      if (p.id) {
        out.push({
          kind: 'patch',
          table: 'deliveries',
          id: String(p.id),
          patch: {
            delivery_date: p.delivery_date ?? null,
            delivery_address: str(p.delivery_address),
            delivery_city: str(p.delivery_city),
            vehicle_number: str(p.vehicle_number),
            notes: str(p.notes),
            updated_at: now,
          },
        })
      }
      break
    case 'delivery.status':
      if (p.id) {
        out.push({
          kind: 'patch',
          table: 'deliveries',
          id: String(p.id),
          patch: p.status === 'delivered' ? { status: p.status, delivered_at: now } : { status: p.status },
        })
      }
      break
    case 'warehouse.create': {
      const d = p.data || {}
      out.push({
        kind: 'row',
        table: 'warehouses',
        row: stamp({
          id: p.id || synthId('wh'),
          name: d.name ?? null,
          code: str(d.code),
          address: str(d.address),
          city: str(d.city),
          is_default: d.is_default === true,
          is_active: d.is_active !== false,
        }),
      })
      break
    }
    case 'warehouse.update':
      if (p.id) {
        out.push({ kind: 'patch', table: 'warehouses', id: String(p.id), patch: { ...(p.data || {}) } })
      }
      break
    case 'project.create': {
      const d = p.data || {}
      out.push({
        kind: 'row',
        table: 'projects',
        row: stamp({
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
        }),
      })
      break
    }
    case 'project.update':
      if (p.id) {
        out.push({ kind: 'patch', table: 'projects', id: String(p.id), patch: { ...(p.data || {}), updated_at: now } })
      }
      break
    case 'product.status':
      if (p.id) {
        out.push({ kind: 'patch', table: 'products', id: String(p.id), patch: { is_active: p.is_active !== false } })
      }
      break
    case 'customer_note.create':
      out.push({
        kind: 'row',
        table: 'customer_notes',
        row: stamp({
          id: p.id || synthId('note'),
          customer_id: p.customer_id ?? null,
          note: p.note ?? null,
          note_type: p.note_type || 'general',
        }),
      })
      break
    case 'customer_note.delete':
      if (p.id) {
        out.push({ kind: 'delete', table: 'customer_notes', id: String(p.id) })
      }
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
          kind: 'row',
          table: 'stock_movements',
          row: stamp({
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
          }),
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
let overlayCache = new Map<string, { at: number; overlay: Overlay }>()
let payloadCache = new Map<string, { at: number; payload: Record<string, any> | null }>()
let changeToken = 0

export interface Overlay {
  /** Provisional rows (created offline, patches applied, deletes removed). */
  rows: any[]
  /** Patches for REAL replica rows, keyed by id, applied in queue order. */
  patches: Map<string, Patch[]>
  /** Row ids removed by queued deletes. */
  deletes: Set<string>
}

/** Drop all overlay caches — called when the outbox changes. */
export function resetPendingCaches(): void {
  overlayCache = new Map()
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

/** Apply a queue-ordered chain of overlay patches to a row (new object). */
export function applyPatchChain(row: any, chain: Patch[]): any {
  let current = row
  for (const patch of chain) {
    current = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) }
  }
  return current
}

/**
 * Everything the overlay contributes to one table: provisional rows, patches
 * for existing rows, and queued deletions. Effects compose in queue order —
 * create → payment → status chains land correctly on the same row.
 */
export async function pendingOverlayFor(table: string): Promise<Overlay> {
  const empty: Overlay = { rows: [], patches: new Map(), deletes: new Set() }
  try {
    if (typeof window === 'undefined') return empty
    const hit = overlayCache.get(table)
    if (hit && Date.now() - hit.at < PENDING_TTL) return hit.overlay
    const token = changeToken
    const items = (await getDB().outbox.toArray())
      .filter((i: any) => ACTIVE_STATUSES.has(i.status) && OP_TABLES[i.op])
      .sort((a: any, b: any) => a.createdAt - b.createdAt)

    const collected: any[] = []
    const patches = new Map<string, Patch[]>()
    const deletes = new Set<string>()
    const deletedParents = new Set<string>() // `${parentColumn}|${parentId}`

    for (const item of items) {
      const payload = await unsealItemPayload(item)
      if (!payload) continue
      for (const eff of deriveEffects(item.op, payload, item.id, item.createdAt)) {
        if (eff.table !== table) continue
        if (eff.kind === 'row') {
          const parentKey = parentKeyOf(table, eff.row)
          if (parentKey && deletedParents.has(parentKey)) continue
          if (deletes.has(String(eff.row.id))) continue
          collected.push(eff.row)
        } else if (eff.kind === 'patch') {
          const chain = patches.get(eff.id) || []
          chain.push(eff.patch)
          patches.set(eff.id, chain)
        } else if (eff.kind === 'delete') {
          deletes.add(eff.id)
        } else if (eff.kind === 'deleteParent') {
          deletedParents.add(`${eff.parentColumn}|${eff.parentId}`)
          for (let i = collected.length - 1; i >= 0; i--) {
            if (String(collected[i][eff.parentColumn]) === String(eff.parentId)) collected.splice(i, 1)
          }
        } else if (eff.kind === 'replaceParent') {
          const key = `${eff.parentColumn}|${eff.parentId}`
          deletedParents.add(key)
          for (let i = collected.length - 1; i >= 0; i--) {
            if (String(collected[i][eff.parentColumn]) === String(eff.parentId)) collected.splice(i, 1)
          }
          collected.push(...eff.rows)
        }
      }
    }

    const rows = collected
      .filter((r) => !deletes.has(String(r.id)))
      .map((r) => (patches.has(String(r.id)) ? applyPatchChain(r, patches.get(String(r.id))!) : r))

    const overlay: Overlay = { rows, patches, deletes }
    if (token !== changeToken) return overlay // outbox changed mid-read — caller re-reads soon
    overlayCache.set(table, { at: Date.now(), overlay })
    return overlay
  } catch {
    return empty
  }
}

/** FK column that hangs child rows off a parent, per child table. */
const PARENT_COLUMNS: Record<string, string> = {
  invoice_items: 'invoice_id',
  quotation_items: 'quotation_id',
  purchase_order_items: 'purchase_order_id',
  purchase_return_items: 'purchase_return_id',
  journal_lines: 'journal_entry_id',
}

function parentKeyOf(table: string, row: any): string | null {
  const col = PARENT_COLUMNS[table]
  return col && row[col] != null ? `${col}|${String(row[col])}` : null
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
