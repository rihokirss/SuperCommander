import type { Entry, Location, PaneState, Tab } from "./types";
export const uid = () => crypto.randomUUID();
export function basename(path: string) {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path
  );
}
export function parent(path: string) {
  if (/^\\\\[^\\]+\\?$/.test(path)) return path;
  const share = /^\\\\([^\\]+)\\[^\\]+\\?$/.exec(path);
  if (share) return `\\\\${share[1]}`;
  const sep = path.includes("\\") ? "\\" : "/";
  const stripped = path.replace(/[\\/]+$/, "");
  const index = stripped.lastIndexOf(sep);
  if (index < 0) return path;
  const result = stripped.slice(0, index);
  return /^[A-Za-z]:$/.test(result) ? `${result}\\` : result || "/";
}
export const join = (path: string, name: string) =>
  path.replace(/[\\/]+$/, "") + (path.includes("\\") ? "\\" : "/") + name;
export const tab = (location: Location): Tab => ({
  id: uid(),
  location,
  history: [location],
  historyIndex: 0,
});
export const pane = (location: Location): PaneState => {
  const t = tab(location);
  return { tabs: [t], activeTab: t.id };
};
export function size(value: number) {
  if (value < 1024) return `${value} B`;
  const i = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][i]}`;
}
export const extension = (e: Entry) =>
  e.isDir
    ? ""
    : e.name.includes(".")
      ? e.name.split(".").pop()!.toLowerCase()
      : "";
export function sortEntries(
  entries: Entry[],
  key: "name" | "size" | "modified" | "type",
  desc: boolean,
  sizes?: Readonly<Record<string, number>>,
) {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const n =
      key === "name"
        ? a.name.localeCompare(b.name, undefined, {
            numeric: true,
            sensitivity: "base",
          })
        : key === "type"
          ? extension(a).localeCompare(extension(b))
          : key === "size"
            ? (sizes?.[a.path] ?? a.size) - (sizes?.[b.path] ?? b.size)
            : a[key] - b[key];
    return (desc ? -1 : 1) * n;
  });
}
