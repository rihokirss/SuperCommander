import type { ComparisonDirection, ComparisonRow } from "./types";
export type ComparisonPolicy = "newer" | "left" | "right" | "manual";
export function suggested(
  row: ComparisonRow,
  policy: ComparisonPolicy,
): ComparisonDirection | undefined {
  if (policy === "left") return row.toRight ? "left_to_right" : undefined;
  if (policy === "right") return row.toLeft ? "right_to_left" : undefined;
  if (policy === "manual") return;
  if (["left_only", "left_newer"].includes(row.status) && row.toRight)
    return "left_to_right";
  if (["right_only", "right_newer"].includes(row.status) && row.toLeft)
    return "right_to_left";
}
export function choicesFor(rows: ComparisonRow[], policy: ComparisonPolicy) {
  return new Map(
    rows.flatMap((row) => {
      const direction = suggested(row, policy);
      return direction ? [[row.id, direction] as const] : [];
    }),
  );
}
export function applyChoice(
  rows: ComparisonRow[],
  previous: Map<number, ComparisonDirection>,
  row: ComparisonRow,
  direction?: ComparisonDirection,
  caseSensitive = true,
) {
  const next = new Map(previous);
  const key = (path: string) => (caseSensitive ? path : path.toLowerCase());
  const node =
    direction === "right_to_left" ? row.right : row.left || row.right;
  for (const child of rows) {
    if (
      child.id !== row.id &&
      (!node?.entry.isDir || !key(child.path).startsWith(key(row.path) + "/"))
    )
      continue;
    if (!direction) next.delete(child.id);
    else if (
      (direction === "left_to_right" && child.toRight) ||
      (direction === "right_to_left" && child.toLeft)
    )
      next.set(child.id, direction);
  }
  return next;
}
export function folderSelection(
  rows: ComparisonRow[],
  choices: Map<number, ComparisonDirection>,
  caseSensitive: boolean,
) {
  const key = (path: string) => (caseSensitive ? path : path.toLowerCase());
  const folders = new Map(
    rows
      .filter((row) => (row.left || row.right)?.entry.isDir)
      .map((row) => [key(row.path), row.id]),
  );
  const stats = new Map<
    number,
    { total: number; selected: number; left: number; right: number }
  >();
  for (const row of rows) {
    if (!row.toLeft && !row.toRight) continue;
    let path = key(row.path),
      index = path.lastIndexOf("/");
    while (index >= 0) {
      path = path.slice(0, index);
      const id = folders.get(path);
      if (id !== undefined) {
        const value = stats.get(id) || {
          total: 0,
          selected: 0,
          left: 0,
          right: 0,
        };
        value.total++;
        if (choices.has(row.id)) value.selected++;
        if (row.toLeft) value.left++;
        if (row.toRight) value.right++;
        stats.set(id, value);
      }
      index = path.lastIndexOf("/");
    }
  }
  return stats;
}
