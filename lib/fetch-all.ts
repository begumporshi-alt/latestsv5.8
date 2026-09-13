// Fetch every row of a query, paginating past Supabase's 1000-row default
// cap. Takes a builder factory so each page runs a fresh query (builders
// mutate in place, so they can't be reused across pages).
// The query MUST have a deterministic ORDER BY (add an .order('id')
// tiebreaker if the visible sort column isn't unique) or rows can shift
// between pages.
export async function fetchAll<T = any>(build: () => any, pageSize = 1000): Promise<T[]> {
  const rows: T[] = [];
  let pg = 0;
  while (true) {
    const { data, error } = await build().range(pg * pageSize, (pg + 1) * pageSize - 1);
    if (error) throw error;
    const page = (data || []) as T[];
    rows.push(...page);
    if (page.length < pageSize) break;
    pg++;
  }
  return rows;
}

// Parallel variant of fetchAll for large, slow-changing scans (product
// catalogs, reference tables): a whole wave of pages is requested
// concurrently, and further waves follow only while every page in the
// previous one came back full. `firstWave` caps the optimism — the default
// of 4 covers 4,000 rows in one round trip and wastes at most one request
// on a smaller table (the page past the end returns empty). Same contract
// as fetchAll: deterministic ORDER BY required, and pages requested
// concurrently see a slightly wider insert-race window than the serial
// version, so prefer fetchAll for hot transactional tables (invoices,
// journal lines).
export async function fetchAllParallel<T = any>(build: () => any, firstWave = 4, pageSize = 1000): Promise<T[]> {
  const rows: T[] = [];
  let start = 0;
  while (true) {
    const offsets = Array.from({ length: firstWave }, (_, i) => start + i * pageSize);
    const pages = await Promise.all(
      offsets.map((offset) => build().range(offset, offset + pageSize - 1))
    );
    let sawShortPage = false;
    for (const { data, error } of pages) {
      if (error) throw error;
      const page = (data || []) as T[];
      rows.push(...page);
      if (page.length < pageSize) sawShortPage = true;
    }
    if (sawShortPage) break;
    start += firstWave * pageSize;
  }
  return rows;
}
