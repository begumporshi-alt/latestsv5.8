/**
 * Canonical cache keys. Pages and the shared gates (oversell/credit) read and
 * write these same keys, so a snapshot cached by the POS is visible to the
 * gate fallback and vice versa. All entries are full-row selects so any
 * consumer can use them.
 */

export const CACHE_KEYS = {
  products: 'products:all',
  customers: 'customers:all',
  employees: 'employees:all',
  paymentMethods: 'payment-methods:all',
  warehouses: 'warehouses:all',
  categories: 'categories:all',
  brands: 'brands:all',
  /** rows from get_batch_stock_by_product_warehouse — the oversell gate snapshot */
  gateStock: 'gate:stock',
  /** the inventory page's full aggregate (products + stock + stats + FIFO values) */
  inventoryPage: 'inventory:page-data',
  /** the CRM page's enriched customers + stats aggregate */
  crmPage: 'crm:page-data',
  /** first page of the sales list, for offline order review */
  invoicesRecent: 'invoices:recent',
  /** last 60 days of attendance rows */
  attendanceRecent: 'attendance:recent',
  /** POS product units, keyed per product id */
  productUnits: (productId: string) => `product-units:${productId}`,
} as const;
