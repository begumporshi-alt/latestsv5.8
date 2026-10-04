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

export function downloadFile(file: File) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export type PdfShareResult = 'shared' | 'downloaded';

/**
 * Hand the PDF to the OS share sheet (WhatsApp, Mail, etc.) when the browser
 * supports file sharing; otherwise download it so the user can attach it
 * manually.
 */
export async function sharePdfFile(file: File, text: string): Promise<PdfShareResult> {
  const nav = navigator as Navigator & {
    canShare?: (data: { files?: File[] }) => boolean;
    share?: (data: { files?: File[]; text?: string; title?: string }) => Promise<void>;
  };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    await nav.share({ files: [file], text, title: file.name });
    return 'shared';
  }
  downloadFile(file);
  return 'downloaded';
}
