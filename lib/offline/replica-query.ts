/**
 * Answers recorded postgrest builder chains from the local replica database.
 *
 * lib/offline/read-fallback.ts records every method call made on a
 * `.from(table)` read (`steps: [method, args][]`). This module replays such a
 * chain against the replica tables — filter → count → order → slice → single,
 * plus relation embeds (`customer:customers(name)`, `items:invoice_items(*)`)
 * resolved through the schema's foreign keys, including filters on embedded
 * parents (`journal_entries.entry_date` on a journal_lines query).
 *
 * Anything the interpreter does not recognize returns `null` ("unsupported")
 * and the caller falls back to the offline notice: it can never return wrong
 * data, only decline.
 */

import { REPLICA_BY_TABLE, replicaRows, subscribeReplica, type ReplicaTableSpec } from './replica'
import { getMeta } from './db'

export interface ReplicaQueryResult {
  data: any
  count: number | null
}

type Step = [string, unknown[]]

type Op = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'is' | 'in'

interface Filter {
  column: string
  op: Op
  value: unknown
  negate: boolean
}

interface OrderClause {
  column: string
  asc: boolean
}

interface ParsedSteps {
  filters: Filter[]
  orAsts: OrAst[]
  orders: OrderClause[]
  limit: number | null
  offset: number
  terminator: 'single' | 'maybeSingle' | null
  countExact: boolean
  head: boolean
  selectArg: string | null
}

/* ------------------------------------------------------------------ */
/* Foreign keys (from supabase/migrations — CREATE TABLE + ALTERs)     */
/* ------------------------------------------------------------------ */

interface Fk {
  table: string
  column: string
  parent: string
}

const FOREIGN_KEYS: Fk[] = [
  { table: 'accounts', column: 'parent_id', parent: 'accounts' },
  { table: 'bank_reconciliation_items', column: 'account_id', parent: 'accounts' },
  { table: 'bank_reconciliation_items', column: 'journal_line_id', parent: 'journal_lines' },
  { table: 'categories', column: 'parent_id', parent: 'categories' },
  { table: 'customer_advance_applications', column: 'advance_id', parent: 'customer_advances' },
  { table: 'customer_advance_applications', column: 'customer_id', parent: 'customers' },
  { table: 'customer_advance_applications', column: 'invoice_id', parent: 'invoices' },
  { table: 'customer_advance_refunds', column: 'advance_id', parent: 'customer_advances' },
  { table: 'customer_advance_refunds', column: 'customer_id', parent: 'customers' },
  { table: 'customer_advances', column: 'customer_id', parent: 'customers' },
  { table: 'customer_notes', column: 'customer_id', parent: 'customers' },
  { table: 'customer_store_credits', column: 'customer_id', parent: 'customers' },
  { table: 'customer_store_credits', column: 'sales_return_id', parent: 'sales_returns' },
  { table: 'deliveries', column: 'customer_id', parent: 'customers' },
  { table: 'deliveries', column: 'invoice_id', parent: 'invoices' },
  { table: 'delivery_items', column: 'delivery_id', parent: 'deliveries' },
  { table: 'delivery_items', column: 'product_id', parent: 'products' },
  { table: 'goods_receipt_notes', column: 'purchase_order_id', parent: 'purchase_orders' },
  { table: 'goods_receipt_notes', column: 'supplier_id', parent: 'suppliers' },
  { table: 'goods_receipt_notes', column: 'warehouse_id', parent: 'warehouses' },
  { table: 'inventory_batches', column: 'product_id', parent: 'products' },
  { table: 'inventory_batches', column: 'variant_id', parent: 'product_variants' },
  { table: 'inventory_batches', column: 'warehouse_id', parent: 'warehouses' },
  { table: 'inventory_items', column: 'product_id', parent: 'products' },
  { table: 'inventory_items', column: 'variant_id', parent: 'product_variants' },
  { table: 'inventory_items', column: 'warehouse_id', parent: 'warehouses' },
  { table: 'invoice_items', column: 'invoice_id', parent: 'invoices' },
  { table: 'invoice_items', column: 'product_id', parent: 'products' },
  { table: 'invoice_items', column: 'variant_id', parent: 'product_variants' },
  { table: 'invoice_items', column: 'warehouse_id', parent: 'warehouses' },
  { table: 'invoices', column: 'customer_id', parent: 'customers' },
  { table: 'invoices', column: 'quotation_id', parent: 'quotations' },
  { table: 'invoices', column: 'warehouse_id', parent: 'warehouses' },
  { table: 'journal_entries', column: 'customer_id', parent: 'customers' },
  { table: 'journal_entries', column: 'supplier_id', parent: 'suppliers' },
  { table: 'journal_lines', column: 'account_id', parent: 'accounts' },
  { table: 'journal_lines', column: 'journal_entry_id', parent: 'journal_entries' },
  { table: 'payment_methods', column: 'account_id', parent: 'accounts' },
  { table: 'payments', column: 'customer_id', parent: 'customers' },
  { table: 'payments', column: 'supplier_id', parent: 'suppliers' },
  { table: 'product_colors', column: 'product_id', parent: 'products' },
  { table: 'product_sizes', column: 'product_id', parent: 'products' },
  { table: 'product_units', column: 'product_id', parent: 'products' },
  { table: 'products', column: 'brand_id', parent: 'brands' },
  { table: 'products', column: 'category_id', parent: 'categories' },
  { table: 'projects', column: 'customer_id', parent: 'customers' },
  { table: 'purchase_order_items', column: 'product_id', parent: 'products' },
  { table: 'purchase_order_items', column: 'purchase_order_id', parent: 'purchase_orders' },
  { table: 'purchase_order_items', column: 'variant_id', parent: 'product_variants' },
  { table: 'purchase_order_items', column: 'warehouse_id', parent: 'warehouses' },
  { table: 'purchase_orders', column: 'supplier_id', parent: 'suppliers' },
  { table: 'purchase_orders', column: 'warehouse_id', parent: 'warehouses' },
  { table: 'purchase_reminders', column: 'product_id', parent: 'products' },
  { table: 'purchase_reminders', column: 'quotation_id', parent: 'quotations' },
  { table: 'purchase_return_items', column: 'product_id', parent: 'products' },
  { table: 'purchase_return_items', column: 'purchase_return_id', parent: 'purchase_returns' },
  { table: 'purchase_returns', column: 'purchase_order_id', parent: 'purchase_orders' },
  { table: 'purchase_returns', column: 'supplier_id', parent: 'suppliers' },
  { table: 'quotation_items', column: 'product_id', parent: 'products' },
  { table: 'quotation_items', column: 'quotation_id', parent: 'quotations' },
  { table: 'quotation_items', column: 'variant_id', parent: 'product_variants' },
  { table: 'quotation_items', column: 'warehouse_id', parent: 'warehouses' },
  { table: 'quotations', column: 'customer_id', parent: 'customers' },
  { table: 'sales_return_items', column: 'invoice_item_id', parent: 'invoice_items' },
  { table: 'sales_return_items', column: 'sales_return_id', parent: 'sales_returns' },
  { table: 'sales_returns', column: 'customer_id', parent: 'customers' },
  { table: 'sales_returns', column: 'invoice_id', parent: 'invoices' },
  { table: 'stock_movements', column: 'product_id', parent: 'products' },
  { table: 'stock_movements', column: 'variant_id', parent: 'product_variants' },
  { table: 'stock_movements', column: 'warehouse_id', parent: 'warehouses' },
  { table: 'store_credit_redemptions', column: 'customer_id', parent: 'customers' },
  { table: 'store_credit_redemptions', column: 'invoice_id', parent: 'invoices' },
  { table: 'store_credit_redemptions', column: 'store_credit_id', parent: 'customer_store_credits' },
]

/* ------------------------------------------------------------------ */
/* Step parsing                                                        */
/* ------------------------------------------------------------------ */

const FILTER_OPS: Record<string, Op> = {
  eq: 'eq',
  neq: 'neq',
  gt: 'gt',
  gte: 'gte',
  lt: 'lt',
  lte: 'lte',
  like: 'like',
  ilike: 'ilike',
  is: 'is',
  in: 'in',
}

const KNOWN_METHODS = new Set([
  'select',
  'order',
  'limit',
  'range',
  'single',
  'maybeSingle',
  'or',
  'not',
  ...Object.keys(FILTER_OPS),
])

function parseInList(raw: string): unknown[] | null {
  let s = raw.trim()
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1)
  if (!s) return []
  return s.split(',').map((v) => {
    let t = v.trim()
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1)
    return t
  })
}

/** Split on top-level commas (commas inside parentheses stay together). */
function splitTop(s: string): string[] | null {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth < 0) return null
    }
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (depth !== 0) return null
  out.push(cur)
  return out
}

type OrAst =
  | { kind: 'or' | 'and'; children: OrAst[] }
  | { kind: 'cond'; column: string; op: Op; value: unknown }

function parseCondition(s: string): OrAst | null {
  const t = s.trim()
  if (!t) return null
  if (t.startsWith('and(') || t.startsWith('or(')) {
    if (!t.endsWith(')')) return null
    const parts = splitTop(t.slice(4, -1))
    if (!parts) return null
    const children: OrAst[] = []
    for (const p of parts) {
      const child = parseCondition(p)
      if (!child) return null
      children.push(child)
    }
    return { kind: t.startsWith('and') ? 'and' : 'or', children }
  }
  // col.op.value — only the first two dots split; values may contain dots
  // (ISO timestamps, decimals).
  const first = t.indexOf('.')
  if (first < 0) return null
  const second = t.indexOf('.', first + 1)
  if (second < 0) return null
  const column = t.slice(0, first)
  const opName = t.slice(first + 1, second)
  const rawValue = t.slice(second + 1)
  const op = FILTER_OPS[opName]
  if (!op || !/^[a-z_]+$/.test(column)) return null
  let value: unknown = rawValue
  if (op === 'is') {
    if (rawValue === 'null') value = null
    else if (rawValue === 'true') value = true
    else if (rawValue === 'false') value = false
    else return null
  } else if (op === 'in') {
    const list = parseInList(rawValue)
    if (!list) return null
    value = list
  }
  return { kind: 'cond', column, op, value }
}

/**
 * A `.or(...)` expression: top-level commas are ORs; `and(...)` / `or(...)`
 * nest. The postgrest-js argument may or may not carry its own outer
 * `or(...)` wrapper — both forms are accepted.
 */
function parseOrExpr(expr: string): OrAst | null {
  const inner = expr.startsWith('or(') && expr.endsWith(')') ? expr.slice(3, -1) : expr
  const parts = splitTop(inner)
  if (!parts) return null
  const children: OrAst[] = []
  for (const p of parts) {
    const child = parseCondition(p)
    if (!child) return null
    children.push(child)
  }
  if (children.length === 0) return null
  return children.length === 1 ? children[0] : { kind: 'or', children }
}

function parseSteps(steps: Step[]): ParsedSteps | null {
  const parsed: ParsedSteps = {
    filters: [],
    orAsts: [],
    orders: [],
    limit: null,
    offset: 0,
    terminator: null,
    countExact: false,
    head: false,
    selectArg: null,
  }
  for (const [method, args] of steps) {
    if (!KNOWN_METHODS.has(method)) return null
    switch (method) {
      case 'select': {
        const [columns, options] = args as [string?, { count?: string; head?: boolean }?]
        if (typeof columns === 'string') parsed.selectArg = columns
        if (options && typeof options === 'object') {
          if (options.count === 'exact') parsed.countExact = true
          if (options.head) parsed.head = true
        }
        break
      }
      case 'order': {
        const [column, options] = args as [string, { ascending?: boolean; foreignTable?: string }?]
        if (typeof column !== 'string') return null
        if (options && typeof options === 'object' && options.foreignTable) return null
        parsed.orders.push({ column, asc: !options || options.ascending !== false })
        break
      }
      case 'limit': {
        const [n] = args
        if (typeof n !== 'number' || n < 0) return null
        parsed.limit = n
        break
      }
      case 'range': {
        const [from, to] = args as [number, number]
        if (typeof from !== 'number' || typeof to !== 'number' || from < 0 || to < from) return null
        parsed.offset = from
        parsed.limit = to - from + 1
        break
      }
      case 'single':
        parsed.terminator = 'single'
        break
      case 'maybeSingle':
        parsed.terminator = 'maybeSingle'
        break
      case 'or': {
        const [expr, options] = args as [string, { foreignTable?: string }?]
        if (typeof expr !== 'string') return null
        if (options && typeof options === 'object' && options.foreignTable) return null
        const ast = parseOrExpr(expr)
        if (!ast) return null
        // Multiple .or() calls AND together.
        parsed.orAsts.push({ kind: 'and', children: [ast] })
        break
      }
      case 'not': {
        const [column, opName, value] = args as [string, string, unknown]
        const op = typeof opName === 'string' ? FILTER_OPS[opName] : undefined
        if (typeof column !== 'string' || !op) return null
        let v: unknown = value
        if (op === 'in') {
          if (Array.isArray(value)) v = value
          else if (typeof value === 'string') {
            const list = parseInList(value)
            if (!list) return null
            v = list
          } else return null
        }
        parsed.filters.push({ column, op, value: v, negate: true })
        break
      }
      case 'in': {
        const [column, value] = args as [string, unknown]
        if (typeof column !== 'string') return null
        let list: unknown[] | null = null
        if (Array.isArray(value)) list = value
        else if (typeof value === 'string') list = parseInList(value)
        if (!list) return null
        parsed.filters.push({ column, op: 'in', value: list, negate: false })
        break
      }
      default: {
        // eq / neq / gt / gte / lt / lte / like / ilike / is
        const op = FILTER_OPS[method]
        const [column, value] = args as [string, unknown]
        if (typeof column !== 'string') return null
        if (op === 'is' && value !== null && value !== true && value !== false) return null
        parsed.filters.push({ column, op, value, negate: false })
        break
      }
    }
  }
  return parsed
}

/* ------------------------------------------------------------------ */
/* Value comparison (Postgres-ish semantics)                           */
/* ------------------------------------------------------------------ */

function compare(a: unknown, b: unknown): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  const na = Number(a)
  const nb = Number(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
  return null
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) return false
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b)
  return false
}

function likeToRegex(pattern: string, caseInsensitive: boolean): RegExp | null {
  let re = ''
  for (const ch of pattern) {
    if (ch === '%') re += '[\\s\\S]*'
    else if (ch === '_') re += '.'
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  try {
    return new RegExp(`^${re}$`, caseInsensitive ? 'i' : '')
  } catch {
    return null
  }
}

function applyOp(value: unknown, op: Op, filterValue: unknown): boolean {
  switch (op) {
    case 'eq':
      return valuesEqual(value, filterValue)
    case 'neq':
      return !valuesEqual(value, filterValue)
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const c = compare(value, filterValue)
      if (c === null) return false
      if (op === 'gt') return c > 0
      if (op === 'gte') return c >= 0
      if (op === 'lt') return c < 0
      return c <= 0
    }
    case 'is':
      return valuesEqual(value, filterValue)
    case 'in':
      return Array.isArray(filterValue) && filterValue.some((v) => valuesEqual(value, v))
    case 'like':
    case 'ilike': {
      if (typeof value !== 'string' || typeof filterValue !== 'string') return false
      const re = likeToRegex(filterValue, op === 'ilike')
      return re ? re.test(value) : false
    }
  }
}

/** nulls last on ascending, first on descending (Postgres default). */
function compareOrder(av: unknown, bv: unknown, asc: boolean): number {
  const aNull = av === null || av === undefined
  const bNull = bv === null || bv === undefined
  if (aNull && bNull) return 0
  if (aNull) return asc ? 1 : -1
  if (bNull) return asc ? -1 : 1
  const c = compare(av, bv) ?? 0
  return asc ? c : -c
}

/* ------------------------------------------------------------------ */
/* Replica row loading (memoized, invalidated on replication)          */
/* ------------------------------------------------------------------ */

const ROW_CACHE_TTL = 30_000
const rowCache = new Map<string, { at: number; rows: any[] | null }>()

async function loadRows(table: string): Promise<any[] | null> {
  const spec: ReplicaTableSpec | undefined = (REPLICA_BY_TABLE as Record<string, ReplicaTableSpec | undefined>)[table]
  if (!spec) return null
  const hit = rowCache.get(table)
  if (hit && Date.now() - hit.at < ROW_CACHE_TTL) return hit.rows
  // A table that has never been replicated must read as "unsupported", not
  // as an empty result — otherwise cold devices would show empty pages.
  const count = await getMeta<number>(`replica:count:${spec.name}`)
  if (count === undefined) {
    rowCache.set(table, { at: Date.now(), rows: null })
    return null
  }
  const rows = await replicaRows<any>(spec)
  rowCache.set(table, { at: Date.now(), rows })
  return rows
}

if (typeof window !== 'undefined') {
  subscribeReplica(() => rowCache.clear())
}

/** Test hook: drop memoized rows and parsed embed specs between test cases. */
export function resetReplicaQueryCaches(): void {
  rowCache.clear()
  embedParseCache.clear()
}

async function indexById(table: string): Promise<Map<string, any> | null> {
  const rows = await loadRows(table)
  if (!rows) return null
  const map = new Map<string, any>()
  for (const r of rows) map.set(r.id, r)
  return map
}

/* ------------------------------------------------------------------ */
/* Relation embeds                                                     */
/* ------------------------------------------------------------------ */

interface EmbedSpec {
  /** object key in the result row (alias or table name) */
  key: string
  /** target table */
  target: string
  /** `!inner` requested — parents without a match are dropped */
  inner: boolean
  /** raw inner column string — may itself contain embeds */
  columns: string
}

const embedParseCache = new Map<string, EmbedSpec[] | null>()

function parseEmbeds(selectArg: string | null): EmbedSpec[] | null {
  if (!selectArg || !selectArg.includes('(')) return []
  const cached = embedParseCache.get(selectArg)
  if (cached !== undefined) return cached
  const result = parseEmbedsUncached(selectArg)
  embedParseCache.set(selectArg, result)
  return result
}

function parseEmbedsUncached(selectArg: string): EmbedSpec[] | null {
  const parts = splitTop(selectArg)
  if (!parts) return null
  const embeds: EmbedSpec[] = []
  for (const part of parts) {
    const t = part.trim()
    if (!t.includes('(')) continue // plain scalar column
    // alias:target!hint(cols) | target!hint(cols)
    const m = t.match(/^(?:([a-z_]+):)?([a-z_]+)(![a-z]+)?\((.*)\)$/)
    if (!m) return null
    embeds.push({
      key: m[1] || m[2],
      target: m[2],
      inner: m[3] === '!inner',
      columns: m[4].trim(),
    })
  }
  return embeds
}

const MAX_EMBED_DEPTH = 3

/**
 * Materialize the requested embeds on each row (rows are mutated in place and
 * returned). Returns null when a relation cannot be resolved — the caller
 * treats the whole query as unsupported rather than returning rows that are
 * missing their relations.
 */
async function applyEmbeds(table: string, rows: any[], selectArg: string | null, depth: number): Promise<any[] | null> {
  if (depth > MAX_EMBED_DEPTH) return null
  const embeds = parseEmbeds(selectArg)
  if (!embeds) return null
  if (embeds.length === 0 || rows.length === 0) return rows
  // Shallow-clone before mutating: the loaded rows are memoized and shared
  // between queries — embed keys must never leak into another query's result.
  rows = rows.map((r) => ({ ...r }))

  for (const embed of embeds) {
    // fkUp: FK on this table pointing at the target (many-to-one embed).
    // fkDown: FK on the target pointing back here (one-to-many embed).
    // A self-referencing FK (accounts.parent_id → accounts) matches both
    // directions — it is a many-to-one embed.
    const fkUp = FOREIGN_KEYS.find((f) => f.table === table && f.parent === embed.target)
    const fkDown = FOREIGN_KEYS.find((f) => f.table === embed.target && f.parent === table)
    if (!fkUp && !fkDown) return null

    const childRows = await loadRows(embed.target)
    if (!childRows) return null

    if (fkUp) {
      // many-to-one: a single parent object (or null) per row
      const parentIndex = new Map<string, any>()
      for (const r of childRows) parentIndex.set(r.id, r)
      const materialized = await applyEmbeds(embed.target, [...parentIndex.values()], embed.columns, depth + 1)
      if (!materialized) return null
      const byId = new Map<string, any>()
      childRows.forEach((r, i) => byId.set(r.id, materialized[i]))
      const keep: any[] = []
      for (const row of rows) {
        const parent = row[fkUp.column] ? byId.get(row[fkUp.column]) ?? null : null
        if (embed.inner && !parent) continue
        row[embed.key] = parent
        keep.push(row)
      }
      rows = keep
    } else {
      // one-to-many: an array of children per row
      const groups = new Map<string, any[]>()
      for (const r of childRows) {
        const fk = r[fkDown!.column]
        if (!groups.has(fk)) groups.set(fk, [])
        groups.get(fk)!.push(r)
      }
      const materialized = await applyEmbeds(embed.target, childRows, embed.columns, depth + 1)
      if (!materialized) return null
      // materialized is aligned with childRows order
      const materializedByRef = new Map<any, any>()
      childRows.forEach((r, i) => materializedByRef.set(r, materialized[i]))
      const keep: any[] = []
      for (const row of rows) {
        const group = groups.get(row.id) || []
        const embedded = group.map((r) => materializedByRef.get(r))
        if (embed.inner && embedded.length === 0) continue
        row[embed.key] = embedded
        keep.push(row)
      }
      rows = keep
    }
  }
  return rows
}

/* ------------------------------------------------------------------ */
/* Main entry                                                          */
/* ------------------------------------------------------------------ */

export async function runReplicaQuery(table: string, steps: Step[]): Promise<ReplicaQueryResult | null> {
  try {
    const parsed = parseSteps(steps)
    if (!parsed) return null

    let rows = await loadRows(table)
    if (!rows) return null
    rows = rows.map((r) => ({ ...r }))

    // Filters — including filters on embedded parents ("journal_entries.entry_date").
    const parentIndexes = new Map<string, Map<string, any> | null>()
    for (const f of parsed.filters) {
      if (f.column.includes('.')) {
        const dot = f.column.indexOf('.')
        const relName = f.column.slice(0, dot)
        const col = f.column.slice(dot + 1)
        // The relation prefix is either the target table name
        // ("journal_entries.entry_date") or the embed alias
        // ("invoice.status" for "invoice:invoices(...)").
        let parentTable = relName
        if (!FOREIGN_KEYS.some((fk2) => fk2.table === table && fk2.parent === relName)) {
          const aliasEmbed = (parseEmbeds(parsed.selectArg) ?? []).find((e) => e.key === relName)
          if (aliasEmbed) parentTable = aliasEmbed.target
        }
        const fk = FOREIGN_KEYS.find((fk2) => fk2.table === table && fk2.parent === parentTable)
        if (!fk) return null
        if (!parentIndexes.has(parentTable)) {
          parentIndexes.set(parentTable, await indexById(parentTable))
        }
        const idx = parentIndexes.get(parentTable)!
        if (!idx) return null
        rows = rows.filter((row) => {
          const parent = row[fk.column] ? idx.get(row[fk.column]) : undefined
          const value = parent ? parent[col] : null
          const ok = applyOp(value, f.op, f.value)
          return f.negate ? !ok : ok
        })
      } else {
        rows = rows.filter((row) => {
          const ok = applyOp(row[f.column], f.op, f.value)
          return f.negate ? !ok : ok
        })
      }
    }

    // .or(...) expressions (ANDed together when several are chained).
    for (const ast of parsed.orAsts) {
      rows = rows.filter((row) => evalOrAst(ast, row))
    }

    // count reflects the filtered set, before limit/range slicing.
    const count = parsed.countExact ? rows.length : null

    // Multi-key order. Array#sort is stable, matching PostgREST's implicit
    // primary-key tiebreak closely enough for page rendering.
    if (parsed.orders.length > 0) {
      rows.sort((a, b) => {
        for (const o of parsed.orders) {
          const r = compareOrder(a[o.column], b[o.column], o.asc)
          if (r !== 0) return r
        }
        return 0
      })
    }

    if (parsed.offset > 0 || parsed.limit !== null) {
      const end = parsed.limit !== null ? parsed.offset + parsed.limit : undefined
      rows = rows.slice(parsed.offset, end)
    }

    if (parsed.head) {
      return { data: null, count }
    }

    // Relation embeds requested through .select('..., rel(cols)').
    const embedded = await applyEmbeds(table, rows, parsed.selectArg, 0)
    if (!embedded) return null
    rows = embedded

    if (parsed.terminator) {
      return { data: rows[0] ?? null, count }
    }
    return { data: rows, count }
  } catch {
    // Any surprise (corrupt row, odd shape) must degrade to a miss, never to
    // a half-built result.
    return null
  }
}

function evalOrAst(ast: OrAst, row: any): boolean {
  if (ast.kind === 'cond') return applyOp(row[ast.column], ast.op, ast.value)
  if (ast.kind === 'and') return ast.children.every((c) => evalOrAst(c, row))
  return ast.children.some((c) => evalOrAst(c, row))
}
