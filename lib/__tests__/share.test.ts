import { normalizeWhatsAppPhone } from '../share';

describe('normalizeWhatsAppPhone', () => {
  test('converts local BD numbers with trunk zero to international format', () => {
    expect(normalizeWhatsAppPhone('01712345678')).toBe('8801712345678');
  });

  test('keeps numbers already in international format', () => {
    expect(normalizeWhatsAppPhone('8801712345678')).toBe('8801712345678');
  });

  test('strips + prefix and separators from international numbers', () => {
    expect(normalizeWhatsAppPhone('+880 1712-345678')).toBe('8801712345678');
  });

  test('handles 00 international prefix', () => {
    expect(normalizeWhatsAppPhone('008801712345678')).toBe('8801712345678');
  });

  test('prepends country code to a number with no trunk zero', () => {
    expect(normalizeWhatsAppPhone('1712345678')).toBe('8801712345678');
  });

  test('ignores non-digit characters in local numbers', () => {
    expect(normalizeWhatsAppPhone('+880 1712 345 678')).toBe('8801712345678');
  });

  test('returns empty string for missing or non-numeric input', () => {
    expect(normalizeWhatsAppPhone(null)).toBe('');
    expect(normalizeWhatsAppPhone(undefined)).toBe('');
    expect(normalizeWhatsAppPhone('')).toBe('');
    expect(normalizeWhatsAppPhone('not-a-phone')).toBe('');
  });

  test('respects a custom country code', () => {
    expect(normalizeWhatsAppPhone('09123456789', '91')).toBe('919123456789');
  });
});
