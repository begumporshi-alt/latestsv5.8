// Shared barcode/QR label size definitions. Used by the barcode print page
// and the inventory product modal / single-product barcode modal so a
// product's saved size override prints identically everywhere.

export type LabelSize = 'xs' | 'small' | 'medium' | 'large' | 'xl' | 'custom';

export interface LabelSizeConfig {
  label: string;
  width: string;
  height: string;
  fontSize: string;
  skuFontSize: string;
  barcodeWidth: number;
  barcodeHeight: number;
  qrSize: number;
}

export const LABEL_SIZES: Record<LabelSize, LabelSizeConfig> = {
  xs: { label: '1.2" × 0.6"', width: '1.2in', height: '0.6in', fontSize: '7px', skuFontSize: '6px', barcodeWidth: 1, barcodeHeight: 22, qrSize: 40 },
  small: { label: '1.5" × 0.8"', width: '1.5in', height: '0.8in', fontSize: '8px', skuFontSize: '7px', barcodeWidth: 1, barcodeHeight: 28, qrSize: 50 },
  medium: { label: '2" × 1.1"', width: '2in', height: '1.1in', fontSize: '9px', skuFontSize: '8px', barcodeWidth: 1.5, barcodeHeight: 40, qrSize: 65 },
  large: { label: '2.5" × 1.4"', width: '2.5in', height: '1.4in', fontSize: '10px', skuFontSize: '9px', barcodeWidth: 2, barcodeHeight: 50, qrSize: 80 },
  xl: { label: '3" × 1.6"', width: '3in', height: '1.6in', fontSize: '12px', skuFontSize: '11px', barcodeWidth: 2.5, barcodeHeight: 60, qrSize: 100 },
  custom: { label: 'Custom', width: '2in', height: '1in', fontSize: '9px', skuFontSize: '8px', barcodeWidth: 1.5, barcodeHeight: 40, qrSize: 65 },
};

export interface ProductLabelOverride {
  barcode_label_size?: string | null;
  barcode_label_width?: number | null;
  barcode_label_height?: number | null;
}

// Page-level settings the print page exposes. Font sizes are explicit
// overrides where 0/undefined = derive from the label size preset.
export interface PageLabelSettings {
  size: LabelSize;
  customWidth: number;
  customHeight: number;
  nameFontSize?: number;
  skuFontSize?: number;
  priceFontSize?: number;
  mrpLabelFontSize?: number;
}

export interface ResolvedLabelConfig {
  sizeKey: LabelSize;
  fromProductOverride: boolean;
  width: string;
  height: string;
  barcodeWidth: number;
  barcodeHeight: number;
  qrSize: number;
  nameFontSize: string;
  skuFontSize: string;
  priceFontSize: string;
  mrpLabelFontSize: string;
}

function isValidSize(v: string | null | undefined): v is LabelSize {
  return !!v && (LABEL_SIZES as Record<string, unknown>).hasOwnProperty(v);
}

// A product's saved override wins over the page settings; when the product
// has none (or an unknown preset), the page settings apply.
export function resolveLabelConfig(page: PageLabelSettings, product?: ProductLabelOverride | null): ResolvedLabelConfig {
  const productSize = product?.barcode_label_size;
  const fromProduct = isValidSize(productSize);
  const sizeKey: LabelSize = fromProduct ? productSize : page.size;
  const cfg = LABEL_SIZES[sizeKey] ?? LABEL_SIZES.medium;

  let widthIn = parseFloat(cfg.width);
  let heightIn = parseFloat(cfg.height);
  if (sizeKey === 'custom') {
    if (fromProduct) {
      widthIn = product!.barcode_label_width != null ? Number(product!.barcode_label_width) : page.customWidth;
      heightIn = product!.barcode_label_height != null ? Number(product!.barcode_label_height) : page.customHeight;
    } else {
      widthIn = page.customWidth;
      heightIn = page.customHeight;
    }
  }

  return {
    sizeKey,
    fromProductOverride: fromProduct,
    width: `${widthIn}in`,
    height: `${heightIn}in`,
    barcodeWidth: cfg.barcodeWidth,
    barcodeHeight: cfg.barcodeHeight,
    qrSize: cfg.qrSize,
    nameFontSize: page.nameFontSize && page.nameFontSize > 0 ? `${page.nameFontSize}px` : cfg.fontSize,
    skuFontSize: page.skuFontSize && page.skuFontSize > 0 ? `${page.skuFontSize}px` : cfg.skuFontSize,
    priceFontSize: page.priceFontSize && page.priceFontSize > 0 ? `${page.priceFontSize}px` : '12px',
    mrpLabelFontSize: page.mrpLabelFontSize && page.mrpLabelFontSize > 0 ? `${page.mrpLabelFontSize}px` : '6px',
  };
}

// Short badge text for a product's saved override, e.g. `2.5" × 1.4"`.
export function describeProductLabelSize(product?: ProductLabelOverride | null): string | null {
  const productSize = product?.barcode_label_size;
  if (!isValidSize(productSize)) return null;
  if (productSize === 'custom') {
    const w = product!.barcode_label_width != null ? Number(product!.barcode_label_width) : 2;
    const h = product!.barcode_label_height != null ? Number(product!.barcode_label_height) : 1;
    return `${w}" × ${h}"`;
  }
  return LABEL_SIZES[productSize].label;
}
