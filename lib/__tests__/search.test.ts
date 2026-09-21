import {
  tokenizeSearch,
  buildIlikeOrFilters,
  applyIlikeTokens,
  matchesTokens,
} from '../search';

describe('search helpers (lib/search)', () => {
  describe('tokenizeSearch', () => {
    test('strips PostgREST grammar characters so filters cannot be malformed', () => {
      // A comma used to void the entire .or() filter — the whole search
      // returned nothing with no visible error.
      expect(tokenizeSearch('cable, 3mm')).toEqual(['cable', '3mm']);
      expect(tokenizeSearch('board (12mm)')).toEqual(['board', '12mm']);
      expect(tokenizeSearch('50% cotton')).toEqual(['50', 'cotton']);
      expect(tokenizeSearch('item_1')).toEqual(['item1']);
      expect(tokenizeSearch('a\\b')).toEqual(['ab']);
      expect(tokenizeSearch(`o'brien`)).toEqual(['obrien']);
    });

    test('splits multi-word queries and lower-cases them', () => {
      expect(tokenizeSearch('Gypsum 12MM')).toEqual(['gypsum', '12mm']);
      expect(tokenizeSearch('  spaced   out  ')).toEqual(['spaced', 'out']);
    });

    test('empty / whitespace / non-string input yields no tokens', () => {
      expect(tokenizeSearch('')).toEqual([]);
      expect(tokenizeSearch('    ')).toEqual([]);
      // @ts-expect-error — guard against null slipping in from a form field
      expect(tokenizeSearch(null)).toEqual([]);
    });

    test('caps the number of tokens', () => {
      expect(tokenizeSearch('a b c d e f g')).toHaveLength(5);
      expect(tokenizeSearch('a b c d e f g', 2)).toEqual(['a', 'b']);
    });

    test('a term made only of grammar characters yields no tokens', () => {
      expect(tokenizeSearch(',,,')).toEqual([]);
      expect(tokenizeSearch('()')).toEqual([]);
    });
  });

  describe('buildIlikeOrFilters', () => {
    test('builds one OR filter per token across every column', () => {
      expect(buildIlikeOrFilters(['name', 'sku', 'barcode'], ['gypsum', '12mm'])).toEqual([
        'name.ilike.%gypsum%,sku.ilike.%gypsum%,barcode.ilike.%gypsum%',
        'name.ilike.%12mm%,sku.ilike.%12mm%,barcode.ilike.%12mm%',
      ]);
    });

    test('no tokens → no filters (caller keeps the default list)', () => {
      expect(buildIlikeOrFilters(['name'], [])).toEqual([]);
    });

    test('never emits raw grammar characters into the filter', () => {
      const filters = buildIlikeOrFilters(['name'], tokenizeSearch('cable, 3mm'));
      expect(filters.join('|')).not.toMatch(/[()]/);
      expect(filters).toEqual(['name.ilike.%cable%', 'name.ilike.%3mm%']);
    });
  });

  describe('applyIlikeTokens', () => {
    test('AND-s the tokens by calling .or() once per token', () => {
      const calls: string[] = [];
      const builder = {
        or(filter: string) {
          calls.push(filter);
          return this;
        },
      };
      const result = applyIlikeTokens(builder, ['name', 'sku'], ['gypsum', '12mm']);
      expect(result).toBe(builder);
      expect(calls).toEqual([
        'name.ilike.%gypsum%,sku.ilike.%gypsum%',
        'name.ilike.%12mm%,sku.ilike.%12mm%',
      ]);
    });

    test('is a no-op for an empty query', () => {
      const calls: string[] = [];
      applyIlikeTokens({ or(f: string) { calls.push(f); return this; } }, ['name'], tokenizeSearch('   '));
      expect(calls).toEqual([]);
    });
  });

  describe('matchesTokens (offline twin)', () => {
    const product = { name: '12mm Gypsum Board', sku: 'GYP-12', barcode: '8801234567890' };

    test('matches on name, SKU and barcode', () => {
      expect(matchesTokens(product, ['name', 'sku', 'barcode'], tokenizeSearch('gypsum'))).toBe(true);
      expect(matchesTokens(product, ['name', 'sku', 'barcode'], tokenizeSearch('GYP-12'))).toBe(true);
      expect(matchesTokens(product, ['name', 'sku', 'barcode'], tokenizeSearch('8801234567890'))).toBe(true);
    });

    test('is order-independent for multi-word queries', () => {
      expect(matchesTokens(product, ['name', 'sku', 'barcode'], tokenizeSearch('gypsum 12mm'))).toBe(true);
      expect(matchesTokens(product, ['name', 'sku', 'barcode'], tokenizeSearch('12mm gypsum'))).toBe(true);
      expect(matchesTokens(product, ['name', 'sku', 'barcode'], tokenizeSearch('gypsum 18mm'))).toBe(false);
    });

    test('survives grammar characters in the typed term', () => {
      expect(matchesTokens(product, ['name', 'sku', 'barcode'], tokenizeSearch('board (12mm)'))).toBe(true);
      expect(matchesTokens(product, ['name', 'sku', 'barcode'], tokenizeSearch('gypsum, 12mm'))).toBe(true);
    });

    test('empty query matches everything (default list)', () => {
      expect(matchesTokens(product, ['name'], tokenizeSearch(''))).toBe(true);
    });

    test('tolerates null/undefined columns without throwing', () => {
      expect(matchesTokens({ name: null, sku: undefined }, ['name', 'sku'], ['x'])).toBe(false);
      expect(matchesTokens({}, ['name', 'sku'], tokenizeSearch('  '))).toBe(true);
    });
  });
});
