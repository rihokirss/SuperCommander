import type { Place, Settings } from "./types";
export const networkKey = (path: string) =>
  path.trim().replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
export function networkLocations(
  settings: Pick<Settings, "networkLocations" | "hiddenNetworkPaths">,
  detected: Place[],
) {
  const hidden = new Set((settings.hiddenNetworkPaths || []).map(networkKey));
  const entries = new Map<string, Place>();
  for (const place of settings.networkLocations || [])
    entries.set(networkKey(place.path), place);
  for (const place of detected)
    if (
      !hidden.has(networkKey(place.path)) &&
      !entries.has(networkKey(place.path))
    )
      entries.set(networkKey(place.path), place);
  return [...entries.values()];
}
export function networkPath(value: string) {
  const path = value.trim().replaceAll("/", "\\");
  if (
    (!/^\\\\[^\\]+(?:\\[^\\]+)*\\?$/.test(path) && !/^[a-z]:\\/i.test(path)) ||
    /[\x00-\x1f*?"<>|]/.test(path) ||
    path.split("\\").some((part) => part === "." || part === "..")
  )
    return null;
  return path;
}
