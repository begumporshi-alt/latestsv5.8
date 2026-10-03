/**
 * Share helpers for WhatsApp / Email document sharing.
 *
 * wa.me requires the phone in full international format with no "+", no
 * leading zeros and no separators (e.g. 8801712345678). Customers in this app
 * are usually saved with local-format numbers ("01712345678" or "+8801712..."),
 * which wa.me rejects as an invalid number, so normalize before sharing.
 */

export const DEFAULT_COUNTRY_CODE = '880'; // Bangladesh

export function normalizeWhatsAppPhone(phone: string | null | undefined, countryCode: string = DEFAULT_COUNTRY_CODE): string {
  if (!phone) return '';
  let digits = phone.replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) digits = digits.slice(2);
  const cc = countryCode.replace(/[^0-9]/g, '');
  if (cc && digits.startsWith(cc)) return digits;
  // Local format: leading trunk zero ("01712...") -> swap it for the country code
  if (cc && digits.startsWith('0')) return cc + digits.slice(1);
  // No country code and no trunk zero ("1712...") -> prepend the country code
  if (cc) return cc + digits;
  return digits;
}

export function openWhatsApp(phone: string | null | undefined, text: string, countryCode?: string) {
  const normalized = normalizeWhatsAppPhone(phone, countryCode);
  const encoded = encodeURIComponent(text);
  const url = normalized
    ? `https://wa.me/${normalized}?text=${encoded}`
    : `https://wa.me/?text=${encoded}`;
  window.open(url, '_blank');
}

export function openEmail(email: string | null | undefined, subject: string, body: string) {
  window.location.href = `mailto:${email || ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** 32-char url-safe base64 token (192 bits) for public share links. */
export function generateShareToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function shareLinkUrl(token: string): string {
  return `${window.location.origin}/share/${token}`;
}
