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
