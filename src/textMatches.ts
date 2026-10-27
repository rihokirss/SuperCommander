export function textMatches(text: string, query: string, limit = 10000) {
  const matches: { start: number; end: number }[] = [];
  if (!query || limit <= 0) return matches;
  const expression = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "giu",
  );
  for (const match of text.matchAll(expression)) {
    matches.push({ start: match.index, end: match.index + match[0].length });
    if (matches.length >= limit) break;
  }
  return matches;
}
