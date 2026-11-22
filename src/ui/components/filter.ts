// The text match of the `/` filter bar (filter-bar.tsx), pure so that list
// models filter with it without loading the UI.

/**
 * Whether every word of `query` is in one of `fields`, ignoring case: `sen
 * fail` matches a row whose id has "sen" and whose summary has "fail". An
 * empty query matches everything.
 */
export function matchesQuery(query: string, fields: readonly (string | null | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return true;
  const haystack = fields.filter((f) => f).map((f) => f!.toLowerCase());
  return words.every((w) => haystack.some((f) => f.includes(w)));
}
