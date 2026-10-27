import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Bootstrap,
  Entry,
  JobEvent,
  Listing,
  Location,
  Settings,
  SearchFilter,
  SshCatalog,
} from "./types";
export const desktop = isTauri();
export async function command<T>(
  name: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!desktop) throw new Error("This action is available in the desktop app.");
  return invoke<T>(name, args);
}
export function subscribe<T>(event: string, callback: (data: T) => void) {
  return desktop
    ? listen<T>(event, (e) => callback(e.payload))
    : Promise.resolve(() => {});
}
export const onJob = (callback: (job: JobEvent) => void) =>
  subscribe("job-progress", callback);

const home = "C:\\Users\\Alex";
const demoFolders = [
  "Projects",
  "Documents",
  "Downloads",
  "Pictures",
  "Music",
  "Desktop",
];
const fixtures: Record<string, [string, number][]> = {
  Projects: [
    ["Aurora", -1],
    ["Brand guidelines", -1],
    ["Client work", -1],
    ["Experiments", -1],
    ["Portfolio", -1],
    ["Resources", -1],
    ["README.md", 2840],
    ["design-tokens.json", 12580],
    ["project-notes.md", 5630],
    ["workspace.code-workspace", 960],
  ],
  Documents: [
    ["Archive", -1],
    ["Design assets", -1],
    ["Personal", -1],
    ["References", -1],
    ["Work", -1],
    ["Brand strategy.pdf", 2497560],
    ["Meeting notes.md", 4820],
    ["Project brief.pdf", 1245760],
    ["Quarterly review.xlsx", 148200],
    ["Typography guide.pdf", 524800],
  ],
  Aurora: [
    ["assets", -1],
    ["public", -1],
    ["src", -1],
    [".gitignore", 204],
    ["index.html", 1360],
    ["package.json", 1890],
    ["README.md", 2840],
    ["tsconfig.json", 620],
  ],
  Downloads: [
    ["References", -1],
    ["Inter-fonts.zip", 4256800],
    ["Invoice-1042.pdf", 124800],
    ["Release-notes.txt", 4800],
  ],
};
function sample(path: string): Entry[] {
  const name = path.split("\\").pop() || "";
  const rows =
    path === home
      ? demoFolders.map((n) => [n, -1] as [string, number])
      : fixtures[name] || [];
  return rows.map(([name, bytes], i) => ({
    name,
    path: path.replace(/\\$/, "") + "\\" + name,
    isDir: bytes === -1,
    isSymlink: false,
    size: Math.max(0, bytes),
    modified: 1792756800 - i * 86400,
    hidden: name.startsWith("."),
  }));
}
export async function bootstrap(): Promise<Bootstrap> {
  if (desktop) return invoke("bootstrap");
  let settings: Settings | null = null;
  try {
    settings = JSON.parse(
      localStorage.getItem("supercommander-preview") || "null",
    );
  } catch {
    /* Use defaults for invalid preview data. */
  }
  return {
    home,
    places: demoFolders.map((name) => ({
      name: name.toLowerCase(),
      path: home + "\\" + name,
      kind: name.toLowerCase(),
    })),
    drives: [
      { name: "Windows (C:)", path: "C:\\", kind: "drive" },
      { name: "Workspace (D:)", path: "D:\\", kind: "drive" },
    ],
    settings,
    locale: navigator.language,
  };
}
export async function list(
  location: Location,
  receive: (batch: Listing) => void,
) {
  if (!desktop) {
    receive({ entries: sample(location.path), done: true });
    return;
  }
  const channel = new Channel<Listing>();
  channel.onmessage = receive;
  await invoke("list_directory", { location, channel });
}
export async function search(
  id: string,
  location: Location,
  filter: SearchFilter,
  receive: (batch: Listing) => void,
) {
  if (!desktop) {
    receive({
      entries: sample(location.path).filter((e) =>
        e.name.toLowerCase().includes(filter.query.toLowerCase()),
      ),
      done: true,
    });
    return;
  }
  const channel = new Channel<Listing>();
  channel.onmessage = receive;
  await invoke("search_files", { id, location, filter, channel });
}
export async function saveSettings(value: Settings) {
  if (desktop) await invoke("save_settings", { value });
  else localStorage.setItem("supercommander-preview", JSON.stringify(value));
}
export async function readSshCatalog(path?: string): Promise<SshCatalog> {
  if (desktop) return invoke("read_ssh_config", { path: path || null });
  return {
    path: path || "C:\\Users\\Alex\\.ssh\\config",
    text: "# OpenSSH connections\n",
    revision: null,
    hosts: [],
    warnings: [],
  };
}
