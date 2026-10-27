import type { Bookmark } from "./types";
import { parseRemoteAddress, formatRemoteAddress } from "./address";
import { clipboardPathKey } from "./clipboard";
import { basename } from "./utils";

function localKey(path: string) {
  const windows = path
    .replaceAll("/", "\\")
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "");
  if (windows.startsWith("\\\\")) {
    // Share names are insensitive; the filesystem beneath a share may be sensitive.
    return `\\\\${windows
      .slice(2)
      .split("\\")
      .filter(Boolean)
      .map((part, index) => (index < 2 ? part.toLowerCase() : part))
      .join("\\")}`;
  }
  return clipboardPathKey(path);
}
export function bookmarkKey(bookmark: Pick<Bookmark, "path" | "source">) {
  if (bookmark.source?.startsWith("zip:"))
    return `zip:${localKey(bookmark.source.slice(4))}\0${bookmark.path.replace(/\/+$/, "") || "/"}`;
  try {
    const remote = parseRemoteAddress(bookmark.path);
    if (remote)
      return `ssh:${remote.username}@${remote.host.toLowerCase()}:${remote.port}\0${remote.path.replace(/\/+$/, "") || "/"}`;
  } catch {
    /* Invalid stored paths are handled by normalizeBookmarks. */
  }
  return `local:${localKey(bookmark.path)}`;
}

export function bookmarkPath(
  path: string,
  source?: string,
): Pick<Bookmark, "path" | "source"> | null {
  if (!path || /[\x00-\x1f\x7f]/.test(path)) return null;
  if (source?.startsWith("zip:")) {
    const archive = bookmarkPath(source.slice(4));
    if (!archive || /^(ssh|sftp):\/\//i.test(archive.path)) return null;
    if (!path.startsWith("/") || path.split("/").some((part) => part === ".."))
      return null;
    return {
      source: `zip:${archive.path}`,
      path: path.replace(/\/+$/, "") || "/",
    };
  }
  if (source && source !== "local") return null;
  try {
    const remote = parseRemoteAddress(path);
    if (remote) {
      if (
        !remote.path.startsWith("/") ||
        [remote.path, remote.username, remote.host].some((part) =>
          /[\x00-\x1f\x7f]/.test(part),
        )
      )
        return null;
      return {
        path: formatRemoteAddress(
          { ...remote, id: "", name: "", keyPath: "", saveSecret: false },
          remote.path,
        ),
      };
    }
  } catch {
    return null;
  }
  const windows = path.replaceAll("/", "\\");
  if (
    (/^[a-z]:\\/i.test(windows) ||
      /^\\\\[^\\]+(?:\\[^\\]+)*\\?$/.test(windows)) &&
    !/[<>"|*]/.test(windows) &&
    !windows.replace(/^\\\\\?\\/, "").includes("?")
  )
    return { path: windows };
  // The browser preview and developer build can also run on a Unix filesystem.
  if (path.startsWith("/")) return { path };
  return null;
}

export function normalizeBookmarks(value: unknown): Bookmark[] {
  if (!Array.isArray(value)) return [];
  const entries = new Map<string, Bookmark>();
  for (const item of value) {
    if (!item || typeof item.path !== "string") continue;
    const target = bookmarkPath(
      item.path,
      typeof item.source === "string" ? item.source : undefined,
    );
    if (!target) continue;
    const bookmark = {
      ...target,
      name:
        typeof item.name === "string" && item.name.trim()
          ? item.name.trim()
          : basename(item.path),
      kind: "bookmark",
    };
    const key = bookmarkKey(bookmark);
    if (!entries.has(key)) entries.set(key, bookmark);
  }
  return [...entries.values()];
}
