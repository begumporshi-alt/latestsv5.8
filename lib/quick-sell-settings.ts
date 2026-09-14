// Shared Quick Sell settings (owner corrections 2026-09-14).
// Settings live in app_settings key 'quick_sell' (written by the Settings
// page): { show_qty, show_in_inventory }. Both default OFF per owner
// preference — Quick Sell lines sell exactly 1, and Quick Sell catalog
// entries stay out of the inventory products list until allowed.

export interface QuickSellSettings {
  /** quantity input visible in the Quick Sell form (off = every line sells 1) */
  show_qty: boolean;
  /** Quick Sell catalog entries appear in the inventory products list */
  show_in_inventory: boolean;
}

export const DEFAULT_QUICK_SELL_SETTINGS: QuickSellSettings = {
  show_qty: false,
  show_in_inventory: false,
};

export async function loadQuickSellSettings(supabase: any): Promise<QuickSellSettings> {
  try {
    const { data } = await supabase
      .from('app_settings')
      .select('setting_value')
      .eq('setting_key', 'quick_sell')
      .maybeSingle();
    if (data?.setting_value) {
      return { ...DEFAULT_QUICK_SELL_SETTINGS, ...data.setting_value };
    }
  } catch {
    // fail open to defaults
  }
  return DEFAULT_QUICK_SELL_SETTINGS;
}
