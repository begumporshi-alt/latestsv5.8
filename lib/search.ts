/**
 * Shared search helpers — the canonical implementation behind
 * .agents/skills/search-feature-robustness.
 *
 * Why these exist (all four were real defects in the POS product search):
 *  1. PostgREST's `.or()` filter grammar treats `,` `(` `)` `%` `_` `\` as
 *     syntax, so interpolating a raw term like "cable, 3mm" produced a
 *     malformed filter and the whole search silently returned nothing.
 *  2. Users expect multi-word queries to be order-independent
 *     ("gypsum 12mm" must find "12mm Gypsum Board").
 *  3. A search must match every identifier a user can read off the record
 *     (name / SKU / barcode / code / phone), not just the first two.
 *  4. The offline fallback must apply the exact same predicate as the online
 *     query, or the same search returns different results by network state.
 */

/** Characters that break PostgREST filter-string grammar. */
const GRAMMAR_CHARS = /[,()%_\\'"]/g;

/** How many tokens we let reach the query (each is one `.or()` round trip). */
const MAX_TOKENS = 5;

/**
 * Split a raw query into sanitised, lower-cased tokens.
 * Returns [] for an empty/whitespace query (callers then show the default list).
 */
export function tokenizeSearch(q: string, maxTokens = MAX_TOKENS): string[] {
  return String(q || '')
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(GRAMMAR_CHARS, ''))
    .filter(Boolean)
    .slice(0, maxTokens)
    .map((t) => t.toLowerCase());
}

/**
 * One PostgREST `.or()` filter string per token.
 * Apply each with `.or(...)`: PostgREST ANDs separate top-level filters, so
 * tokens AND together while each token ORs across the given columns.
 */
export function buildIlikeOrFilters(columns: string[], tokens: string[]): string[] {
  return tokens.map((t) => columns.map((c) => `${c}.ilike.%${t}%`).join(','));
}

/** Minimal structural type for a PostgREST builder (keeps this lib dependency-free). */
interface OrBuilder<T> {
  or(filter: string): T;
}

/** Apply token filters to a Supabase query builder, AND-ing the tokens. */
export function applyIlikeTokens<T extends OrBuilder<T>>(query: T, columns: string[], tokens: string[]): T {
  let q = query;
  for (const filter of buildIlikeOrFilters(columns, tokens)) {
    q = q.or(filter);
  }
  return q;
}

/**
 * Client-side twin of the server filter — used by offline / replica /
 * cached-snapshot fallbacks so their results match the online path exactly.
 */
export function matchesTokens(row: Record<string, any>, columns: string[], tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const hay = columns.map((c) => String(row?.[c] ?? '').toLowerCase());
  return tokens.every((t) => hay.some((h) => h.includes(t)));
}
