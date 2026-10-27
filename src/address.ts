import type { SftpProfile } from "./types";
export type RemoteAddress = {
  host: string;
  port: number;
  username: string;
  path: string;
};
export function parseRemoteAddress(input: string): RemoteAddress | null {
  const value = input.trim();
  if (/^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\")) return null;
  if (/^(sftp|ssh):\/\//i.test(value)) {
    const url = new URL(value);
    if (!url.hostname || url.password || url.search || url.hash)
      throw new Error("Invalid remote address");
    const port = url.port ? Number(url.port) : 22;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid port");
    return {
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port,
      username: decodeURIComponent(url.username),
      path: decodeURIComponent(url.pathname) || "/",
    };
  }
  if (value.includes("://")) throw new Error("Unsupported protocol");
  const scp = /^(?:([^@/\s:]+)@)?(\[[^\]]+\]|[^:/\\\s]+):(\/.*)$/.exec(value);
  if (scp)
    return {
      username: scp[1] || "",
      host: scp[2].replace(/^\[|\]$/g, ""),
      port: 22,
      path: scp[3],
    };
  return null;
}
export function formatRemoteAddress(profile: SftpProfile, path: string) {
  const host = profile.host.includes(":") ? `[${profile.host}]` : profile.host;
  return `sftp://${profile.username ? encodeURIComponent(profile.username) + "@" : ""}${host}${profile.port === 22 ? "" : ":" + profile.port}${path.split("/").map(encodeURIComponent).join("/") || "/"}`;
}
