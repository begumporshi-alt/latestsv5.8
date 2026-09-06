// Shared VAT helpers (batch 2 of the 2026-09-06 gap audit, P0-1).
// Settings live in app_settings key 'vat' (written by the Settings page):
//   { enabled, rate (percent), mode: 'exclusive' | 'inclusive', default_on }
// Posting is server-side: invoice_accounting_trigger splits tax_amount out of
// revenue into VAT Payable (2100). These helpers only compute what the user sees.

export interface VatSettings {
  enabled: boolean;
  rate: number; // percent, e.g. 15
  mode: 'exclusive' | 'inclusive';
  default_on: boolean;
}

export const DEFAULT_VAT_SETTINGS: VatSettings = {
  enabled: false,
  rate: 15,
  mode: 'exclusive',
  default_on: true,
};

export async function loadVatSettings(supabase: any): Promise<VatSettings> {
  try {
    const { data } = await supabase
      .from('app_settings')
      .select('setting_value')
      .eq('setting_key', 'vat')
      .maybeSingle();
    if (data?.setting_value) {
      return { ...DEFAULT_VAT_SETTINGS, ...data.setting_value };
    }
  } catch {
    // fail open: VAT off
  }
  return DEFAULT_VAT_SETTINGS;
}

export interface VatBreakdown {
  taxAmount: number; // VAT portion of the total
  total: number;     // what the customer owes/pays (invoice total_amount)
  net: number;       // revenue net of VAT (what posts to account 4000)
}

/**
 * base = the discounted document base BEFORE VAT in exclusive mode
 * (line prices exclude VAT); in inclusive mode base is the VAT-embedded
 * total the customer pays (line prices already include VAT).
 */
export function computeVat(base: number, settings: VatSettings, applied: boolean): VatBreakdown {
  const b = Math.max(0, Number(base) || 0);
  if (!settings.enabled || !applied || !settings.rate || settings.rate <= 0) {
    return { taxAmount: 0, total: b, net: b };
  }
  const r = settings.rate / 100;
  if (settings.mode === 'inclusive') {
    const tax = b - b / (1 + r);
    return { taxAmount: tax, total: b, net: b - tax };
  }
  const tax = b * r;
  return { taxAmount: tax, total: b + tax, net: b };
}
