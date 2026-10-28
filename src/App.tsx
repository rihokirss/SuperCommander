import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { version } from "../package.json";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowDownUp,
  Archive,
  BookOpen,
  Info,
  ChevronDown,
  Cloud,
  Copy,
  Scissors,
  ClipboardPaste as PasteIcon,
  Download,
  Eye,
  FilePenLine,
  FileCode2,
  Cable,
  Folder,
  FolderPlus,
  HardDrive,
  History,
  Home,
  Image,
  Keyboard,
  LayoutGrid,
  LoaderCircle,
  Minus,
  Monitor,
  Music2,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Settings2,
  Square,
  Star,
  TerminalSquare,
  Video,
  Wifi,
  X,
} from "lucide-react";
import * as api from "./api";
import { dictionary } from "./i18n";
import { basename, parent, pane, size, tab, uid } from "./utils";
import {
  FilePane,
  type PaneHandle,
  type PaneSnapshot,
} from "./components/FilePane";
import { IconButton } from "./components/Primitives";
import {
  ActionDialog,
  ConnectDialog,
  Palette,
  RenameDialog,
  SettingsDialog,
  ShortcutsDialog,
  type ActionData,
  type PaletteAction,
} from "./components/Dialogs";
import { PreviewDialog } from "./components/PreviewDialog";
import { ComparisonDialog } from "./components/ComparisonDialog";
import { RecoveryDialog } from "./components/RecoveryDialog";
import { SearchDialog } from "./components/SearchDialog";
import { TextWorkbench } from "./components/TextWorkbench";
import { QueuePanel } from "./components/QueuePanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { WorkspaceTools } from "./components/WorkspaceTools";
import { formatRemoteAddress, parseRemoteAddress } from "./address";
import { ForwardDialog, SshCatalogDialog } from "./components/SshTools";
import { Tooltips } from "./components/Tooltips";
import { Menu, type MenuAction } from "./components/Menu";
import { NetworkDialog } from "./components/NetworkDialog";
import { networkLocations } from "./network";
import { BookmarksDialog } from "./components/BookmarksDialog";
import { bookmarkKey, normalizeBookmarks } from "./bookmarks";
import { PropertiesDialog } from "./components/PropertiesDialog";
import type {
  Bootstrap,
  Entry,
  Job,
  JobRequest,
  FileClipboard,
  ClipboardProgress,
  ClipboardPaste,
  Location,
  Operation,
  Settings,
  SftpProfile,
  SshCatalog,
  CatalogHost,
  Tab,
  Bookmark,
} from "./types";

type Dialog =
  | { kind: "action"; data: ActionData }
  | { kind: "rename"; entries: Entry[]; source: string }
  | {
      kind: "preview";
      location: Location;
      line?: number;
      column?: number;
      connection?: string | null;
    }
  | {
      kind: "edit";
      location: Location;
      newFile?: boolean;
      line?: number;
      column?: number;
      connection?: string | null;
    }
  | {
      kind: "connect";
      profile?: SftpProfile;
      destination?: { pane: number; path: string };
    }
  | { kind: "sshConfig"; add?: boolean }
  | { kind: "forward"; source: string; title: string }
  | { kind: "bookmarks"; seed?: Bookmark | null }
  | { kind: "properties"; location: Location; entries: Entry[] }
  | { kind: "comparison"; left: Location; right: Location }
  | { kind: "recovery"; location: Location; selectedKey?: string }
  | { kind: "settings" | "search" | "palette" | "network" | "shortcuts" };
const emptySnapshot: PaneSnapshot = { entries: [], selected: [] };
export function App() {
  const [boot, setBoot] = useState<Bootstrap>();
  const [settings, setSettings] = useState<Settings>();
  const [bootError, setBootError] = useState("");
  const [active, setActive] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [dialog, setDialog] = useState<Dialog>();
  const [bookmarkMenu, setBookmarkMenu] = useState<{
    bookmark: Bookmark;
    x: number;
    y: number;
  }>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [queueOpen, setQueueOpen] = useState(false);
  const [fileClipboard, setFileClipboard] = useState<FileClipboard | null>(
    null,
  );
  const clipboardRevision = useRef(-1);
  const clipboardBusy = useRef(false);
  const clipboardTask = useRef<string | undefined>(undefined);
  const clipboardCancelled = useRef<string | undefined>(undefined);
  const clipboardPlanning = useRef<string | undefined>(undefined);
  const [clipboardProgress, setClipboardProgress] =
    useState<ClipboardProgress>();
  const clipboardFinishing = useRef(new Set<Promise<unknown>>());
  const deferredCuts = useRef<{ clipboard: FileClipboard; invalid: boolean }[]>(
    [],
  );
  const clipboardMoves = useRef(new Map<string, FileClipboard>());
  const [terminals, setTerminals] = useState<
    Record<string, Location & { label: string }>
  >({});
  const [terminalSource, setTerminalSource] = useState("local");
  const [terminalView, setTerminalView] = useState<
    "hidden" | "docked" | "full"
  >("hidden");
  const terminalReturnView = useRef<"hidden" | "docked">("hidden");
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [toast, setToast] = useState("");
  const [split, setSplit] = useState(50);
  const snapshots = useRef<PaneSnapshot[]>([emptySnapshot, emptySnapshot]);
  const paneControls = useRef<(PaneHandle | null)[]>([null, null]);
  const closedTabs = useRef<Tab[][]>([[], []]);
  const [context, setContext] = useState<{
    index: number;
    entries: Entry[];
    location: Location;
    position: { x: number; y: number };
  }>();
  const remoteHomes = useRef(new Map<string, string>());
  const [catalog, setCatalog] = useState<SshCatalog>();
  const [sessions, setSessions] = useState<SftpProfile[]>([]);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const stateRef = useRef(settings);
  stateRef.current = settings;
  const activeRef = useRef(active);
  activeRef.current = active;
  const layout = useRef<HTMLDivElement>(null);
  const t = dictionary(settings?.language || "en");
  const resolvedTheme =
    settings?.theme === "system"
      ? systemDark
        ? "dark"
        : "light"
      : settings?.theme || "dark";
  useEffect(() => {
    if (settings?.language) document.documentElement.lang = settings.language;
  }, [settings?.language]);
  useEffect(() => {
    if (!api.desktop || !settings) return;
    const timer = setTimeout(() => {
      void api
        .command("set_window_appearance", {
          glass: settings.glass,
          transparency: settings.transparency ?? 15,
          light: resolvedTheme === "light",
        })
        .catch((e) => notify(String(e)));
    }, 120);
    return () => clearTimeout(timer);
  }, [settings?.glass, settings?.transparency, resolvedTheme]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setSystemDark(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  const notify = useCallback((message: string) => setToast(message), []);
  const closeDialog = useCallback(() => setDialog(undefined), []);
  const update = useCallback(
    (patch: Partial<Settings>) =>
      setSettings((s) => (s ? { ...s, ...patch } : s)),
    [],
  );
  const current = settings?.panes[active].tabs.find(
    (x) => x.id === settings.panes[active].activeTab,
  )?.location;
  async function initialize() {
    setBootError("");
    try {
      const data = await api.bootstrap();
      const saved = data.settings;
      const home = { source: "local", path: data.home };
      const defaults: Settings = {
        language: (api.desktop ? navigator.language : data.locale).startsWith(
          "et",
        )
          ? "et"
          : "en",
        theme: "dark",
        panes: [
          pane(
            api.desktop ? home : { ...home, path: data.home + "\\Projects" },
          ),
          pane({
            ...home,
            path:
              data.places.find(
                (p) => p.kind === (api.desktop ? "downloads" : "documents"),
              )?.path || data.home,
          }),
        ],
        bookmarks: [],
        showHidden: false,
        glass: true,
        density: "compact",
        profiles: [],
        trustedHosts: {},
      };
      const validPanes =
        saved?.panes?.length === 2 &&
        saved.panes.every(
          (p) =>
            p.tabs?.length &&
            p.tabs.every(
              (t) =>
                typeof t.location?.path === "string" &&
                Array.isArray(t.history),
            ),
        );
      const restored = {
        ...defaults,
        ...saved,
        bookmarks: normalizeBookmarks(saved?.bookmarks),
        language:
          saved?.language === "et"
            ? "et"
            : saved?.language === "en"
              ? "en"
              : defaults.language,
        panes: validPanes
          ? saved!.panes
              .map((p) => ({
                ...p,
                tabs: p.tabs.map((t) =>
                  t.location.source.startsWith("sftp:") ? tab(home) : t,
                ),
              }))
              .map((p) => ({
                ...p,
                activeTab: p.tabs.some((t) => t.id === p.activeTab)
                  ? p.activeTab
                  : p.tabs[0].id,
              }))
          : defaults.panes,
      } as Settings;
      setBoot(data);
      setSettings(restored);
    } catch (e) {
      setBootError(String(e));
    }
  }
  useEffect(() => {
    void initialize();
  }, []);
  useEffect(() => {
    if (!settings) return;
    document.documentElement.lang = settings.language;
    const timer = setTimeout(
      () =>
        api.saveSettings(settings).catch((e) => notify(`${t.unsaved}: ${e}`)),
      500,
    );
    return () => clearTimeout(timer);
  }, [settings]);
  useEffect(() => {
    if (!settings) return;
    let active = true;
    const load = () =>
      api
        .readSshCatalog(settings.sshConfigPath)
        .then((value) => {
          if (active) setCatalog(value);
        })
        .catch((e) => {
          if (active) notify(String(e));
        });
    void load();
    window.addEventListener("focus", load);
    return () => {
      active = false;
      window.removeEventListener("focus", load);
    };
  }, [!!settings, settings?.sshConfigPath]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 6500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    const subscription = api.onJob((event) => {
      setJobs((old) =>
        old.map((j) => (j.id === event.id ? { ...j, ...event } : j)),
      );
      if (event.state === "conflict") setQueueOpen(true);
      if (["completed", "failed", "cancelled"].includes(event.state)) {
        setRefresh((n) => n + 1);
        const pending = clipboardMoves.current.get(event.id);
        if (pending) {
          clipboardMoves.current.delete(event.id);
          finishClipboardMove(
            pending,
            event.state === "failed" &&
              event.errors.some((error) => error.includes("clipboard source")),
          );
        }
      }
    });
    return () => {
      subscription.then((fn) => fn());
    };
  }, []);
  useEffect(() => {
    if (!api.desktop) return;
    let active = true,
      reading = false;
    const sync = async () => {
      if (!active || reading || !document.hasFocus()) return;
      reading = true;
      try {
        const revision = await api.command<number>("clipboard_revision");
        if (revision !== clipboardRevision.current) {
          const value = await api.command<FileClipboard | null>(
            "read_file_clipboard",
          );
          if (active) {
            setFileClipboard(value);
            clipboardRevision.current = value?.revision ?? revision;
          }
        }
      } catch {
        /* Another application may briefly own the clipboard. Retry without interrupting the user. */
      } finally {
        reading = false;
      }
    };
    void sync();
    const timer = setInterval(sync, 1000);
    window.addEventListener("focus", sync);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", sync);
    };
  }, []);
  useEffect(() => {
    if (!api.desktop) return;
    const subscription = getCurrentWindow().onDragDropEvent((e) => {
      if (e.payload.type !== "drop") return;
      const payload = e.payload;
      getCurrentWindow()
        .scaleFactor()
        .then((scale) => {
          const hit = document
            .elementFromPoint(
              payload.position.x / scale,
              payload.position.y / scale,
            )
            ?.closest<HTMLElement>("[data-pane]");
          if (!hit) return;
          const index = Number(hit.dataset.pane);
          const s = stateRef.current;
          if (!s) return;
          const location = s.panes[index].tabs.find(
            (t) => t.id === s.panes[index].activeTab,
          )?.location;
          if (!location) return;
          void enqueue({
            id: uid(),
            operation: "copy",
            source: "local",
            paths: payload.paths,
            destination: location,
            conflict: "ask",
          }).catch((e) => notify(String(e)));
        });
    });
    return () => {
      subscription.then((fn) => fn());
    };
  }, []);
  function navigate(location: Location, index = activeRef.current) {
    try {
      const remote = parseRemoteAddress(location.path);
      if (remote) {
        const imported = catalogRef.current?.hosts.find(
          (h) => h.alias.toLowerCase() === remote.host.toLowerCase(),
        );
        if (imported?.disabled) {
          notify(imported.warnings.join("\n"));
          return;
        }
        const profiles = [
          ...new Map(
            [...(stateRef.current?.profiles || []), ...sessionsRef.current].map(
              (profile) => [profile.id, profile],
            ),
          ).values(),
        ].filter(
          (p) =>
            !p.id.startsWith("config-") &&
            p.host.toLowerCase() === remote.host.toLowerCase() &&
            p.port === remote.port &&
            (!remote.username || p.username === remote.username),
        );
        const profile = imported
          ? remote.username && remote.username !== imported.profile.username
            ? { ...imported.profile, id: uid(), username: remote.username }
            : imported.profile
          : profiles.length === 1
            ? profiles[0]
            : {
                id: uid(),
                name: remote.host,
                host: remote.host,
                port: remote.port,
                username: remote.username,
                keyPath: "",
                saveSecret: false,
              };
        const source = `sftp:${profile.id}`;
        if (remoteHomes.current.has(source))
          location = { source, path: remote.path };
        else {
          setDialog({
            kind: "connect",
            profile,
            destination: { pane: index, path: remote.path },
          });
          return;
        }
      } else if (
        /^[a-z]:[\\/]/i.test(location.path) ||
        location.path.startsWith("\\\\")
      )
        location = { source: "local", path: location.path };
    } catch {
      notify(t.remoteAddressError);
      return;
    }
    setSettings((s) =>
      s
        ? {
            ...s,
            panes: s.panes.map((p, i) =>
              i !== index
                ? p
                : {
                    ...p,
                    tabs: p.tabs.map((t) =>
                      t.id !== p.activeTab
                        ? t
                        : {
                            ...t,
                            location,
                            history: [
                              ...t.history.slice(0, t.historyIndex + 1),
                              location,
                            ],
                            historyIndex: t.historyIndex + 1,
                          },
                    ),
                  },
            ),
          }
        : s,
    );
  }
  function history(delta: number, index: number) {
    setSettings((s) =>
      s
        ? {
            ...s,
            panes: s.panes.map((p, i) =>
              i !== index
                ? p
                : {
                    ...p,
                    tabs: p.tabs.map((t) => {
                      const n = t.historyIndex + delta;
                      return t.id !== p.activeTab ||
                        n < 0 ||
                        n >= t.history.length
                        ? t
                        : { ...t, historyIndex: n, location: t.history[n] };
                    }),
                  },
            ),
          }
        : s,
    );
  }
  function newTab(index = active) {
    setSettings((s) => {
      if (!s) return s;
      const p = s.panes[index];
      const current = p.tabs.find((t) => t.id === p.activeTab)!;
      const next = tab(current.location);
      return {
        ...s,
        panes: s.panes.map((p, i) =>
          i !== index ? p : { tabs: [...p.tabs, next], activeTab: next.id },
        ),
      };
    });
  }
  function closeTab(id: string, index: number) {
    const state = stateRef.current?.panes[index];
    const closing = state?.tabs.find((t) => t.id === id);
    if (!closing || state!.tabs.length <= 1) return;
    closedTabs.current[index] = [
      ...closedTabs.current[index].filter((t) => t.id !== id),
      closing,
    ].slice(-10);
    setSettings((s) =>
      s
        ? {
            ...s,
            panes: s.panes.map((p, i) => {
              if (i !== index || p.tabs.length === 1) return p;
              const tabs = p.tabs.filter((t) => t.id !== id);
              return {
                tabs,
                activeTab:
                  p.activeTab === id ? tabs[tabs.length - 1].id : p.activeTab,
              };
            }),
          }
        : s,
    );
  }
  function cycleTab(delta: number) {
    if (!settings) return;
    const pane = settings.panes[active];
    const index = pane.tabs.findIndex((t) => t.id === pane.activeTab);
    const next =
      pane.tabs[(index + delta + pane.tabs.length) % pane.tabs.length];
    update({
      panes: settings.panes.map((p, i) =>
        i === active ? { ...p, activeTab: next.id } : p,
      ),
    });
  }
  function reopenTab() {
    const closed = closedTabs.current[active].pop();
    if (!closed || !settings) return;
    update({
      panes: settings.panes.map((p, i) =>
        i === active ? { tabs: [...p.tabs, closed], activeTab: closed.id } : p,
      ),
    });
  }
  function locationAt(index: number) {
    const pane = settings?.panes[index];
    return pane?.tabs.find((t) => t.id === pane.activeTab)?.location;
  }
  function compareDirectories() {
    const left = locationAt(0),
      right = locationAt(1);
    if (left && right)
      setDialog({ kind: "comparison", left: { ...left }, right: { ...right } });
  }
  function comparisonLabel(location: Location) {
    if (location.source === "local") return t.local;
    if (location.source.startsWith("zip:"))
      return basename(location.source.slice(4));
    const profile = sessions.find(
      (profile) => `sftp:${profile.id}` === location.source,
    );
    return profile
      ? `${profile.name} · ${profile.username}@${profile.host}:${profile.port}`
      : t.remoteFiles;
  }
  function openRecovery(location = locationAt(active), selectedKey?: string) {
    if (location)
      setDialog({ kind: "recovery", location: { ...location }, selectedKey });
  }
  async function enqueue(request: JobRequest) {
    const job: Job = {
      id: request.id,
      operation: request.operation,
      count: request.paths.length,
      state: "queued",
      current: request.paths[0] || "",
      bytes: 0,
      total: 0,
      completed: 0,
      errors: [],
    };
    setJobs((old) => [...old, job]);
    setQueueOpen(true);
    try {
      await api.command("enqueue_job", { request });
    } catch (e) {
      setJobs((old) =>
        old.map((j) =>
          j.id === request.id
            ? { ...j, state: "failed", errors: [String(e)] }
            : j,
        ),
      );
      throw e;
    }
  }
  function chosenEntries(index: number) {
    const snapshot = snapshots.current[index];
    return snapshot.selected.length
      ? snapshot.selected
      : snapshot.focused
        ? [snapshot.focused]
        : [];
  }
  async function copyFiles(
    cut: boolean,
    index = active,
    entries = chosenEntries(index),
  ) {
    const source = locationAt(index);
    if (!source || !entries.length) {
      notify(t.selectFiles);
      return;
    }
    if (cut && source.source.startsWith("zip:")) {
      notify(t.readOnly);
      return;
    }
    if (clipboardBusy.current) return;
    clipboardBusy.current = true;
    const id = uid();
    clipboardTask.current = id;
    setClipboardProgress({ current: entries[0].path, files: 0, bytes: 0 });
    try {
      await Promise.allSettled([...clipboardFinishing.current]);
      if (clipboardCancelled.current === id) throw new Error(t.cancelled);
      const value: FileClipboard = {
        source: source.source,
        paths: entries.map((e) => e.path),
        cut,
        revision: 0,
      };
      const saved = api.desktop
        ? await api.captureClipboard(id, value, (progress) => {
            if (clipboardTask.current === id) setClipboardProgress(progress);
          })
        : { ...value, revision: Math.max(0, clipboardRevision.current + 1) };
      setFileClipboard(saved);
      clipboardRevision.current = saved.revision;
      notify(`${cut ? t.filesCut : t.filesCopied}: ${entries.length}`);
    } catch (e) {
      notify(String(e));
    } finally {
      clipboardBusy.current = false;
      if (clipboardTask.current === id) {
        clipboardTask.current = undefined;
        if (clipboardCancelled.current === id)
          clipboardCancelled.current = undefined;
        setClipboardProgress(undefined);
        for (const pending of deferredCuts.current.splice(0))
          finishClipboardMove(pending.clipboard, pending.invalid);
      }
    }
  }
  function finishClipboardMove(clipboard: FileClipboard, invalid = false) {
    if (clipboardTask.current) {
      deferredCuts.current.push({ clipboard, invalid });
      return;
    }
    const finishing = api
      .command<FileClipboard | null>(
        invalid ? "cancel_file_cut" : "finish_file_paste",
        { clipboard },
      )
      .then((value) => {
        setFileClipboard(value);
        clipboardRevision.current = value?.revision ?? -1;
      })
      .catch((error) => notify(String(error)))
      .finally(() => {
        clipboardFinishing.current.delete(finishing);
      });
    clipboardFinishing.current.add(finishing);
  }
  function cancelClipboardCheck() {
    clipboardCancelled.current = clipboardTask.current;
    if (clipboardTask.current && api.desktop)
      void api
        .command("cancel_search", { id: clipboardTask.current })
        .catch(() => {});
  }
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        clipboardTask.current &&
        !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault();
        event.stopPropagation();
        cancelClipboardCheck();
      }
    };
    document.addEventListener("keydown", cancel, true);
    return () => {
      document.removeEventListener("keydown", cancel, true);
      cancelClipboardCheck();
    };
  }, []);
  async function pasteFiles(index = active, destination = locationAt(index)) {
    if (!destination || clipboardBusy.current) return;
    if (destination.source.startsWith("zip:")) {
      notify(t.readOnly);
      return;
    }
    clipboardBusy.current = true;
    const planId = uid();
    clipboardPlanning.current = planId;
    try {
      const plan = api.desktop
        ? await api.command<ClipboardPaste>("plan_file_paste", {
            destination,
            id: planId,
          })
        : fileClipboard
          ? {
              clipboard: fileClipboard,
              request: {
                id: uid(),
                operation: fileClipboard.cut
                  ? ("move" as const)
                  : ("copy" as const),
                source: fileClipboard.source,
                paths: fileClipboard.paths,
                destination,
                conflict: "ask" as const,
              },
            }
          : undefined;
      if (!plan) {
        notify(t.clipboardEmpty);
        return;
      }
      if (
        plan.clipboard.cut &&
        [...clipboardMoves.current.values()].some(
          (p) => p.revision === plan.clipboard.revision,
        )
      ) {
        notify(t.cutInProgress);
        return;
      }
      setFileClipboard(plan.clipboard);
      if (plan.clipboard.cut)
        clipboardMoves.current.set(plan.request.id, plan.clipboard);
      try {
        const completion = enqueue(plan.request);
        clipboardPlanning.current = undefined;
        clipboardBusy.current = false;
        await completion;
      } catch (e) {
        clipboardMoves.current.delete(plan.request.id);
        throw e;
      }
    } catch (e) {
      notify(String(e));
    } finally {
      if (clipboardPlanning.current === planId) {
        clipboardPlanning.current = undefined;
        if (!clipboardTask.current) clipboardBusy.current = false;
      }
    }
  }
  async function copyPaths(
    index = active,
    entries = chosenEntries(index),
    location = locationAt(index),
  ) {
    if (!location) return;
    const profile = [
      ...(catalog?.hosts.map((h) => h.profile) || []),
      ...sessions,
      ...(settings?.profiles || []),
    ].find((p) => `sftp:${p.id}` === location.source);
    const paths = entries.length ? entries.map((e) => e.path) : [location.path];
    const text = paths
      .map((path) =>
        profile
          ? formatRemoteAddress(profile, path)
          : location.source.startsWith("zip:")
            ? `${location.source.slice(4)}!${path}`
            : path,
      )
      .join("\r\n");
    try {
      if (api.desktop) await api.command("write_clipboard_text", { text });
      else await navigator.clipboard.writeText(text);
      setFileClipboard(null);
      clipboardRevision.current = -1;
      notify(t.pathsCopied);
    } catch (e) {
      notify(String(e));
    }
  }
  async function cancelCut() {
    if (!fileClipboard?.cut) return;
    try {
      const value = api.desktop
        ? await api.command<FileClipboard | null>("cancel_file_cut", {
            clipboard: fileClipboard,
          })
        : null;
      setFileClipboard(value);
      clipboardRevision.current = value?.revision ?? -1;
    } catch (e) {
      notify(String(e));
    }
  }
  function action(
    operation: Operation | "mkdir",
    index = active,
    chosen?: Entry[],
  ) {
    const current = locationAt(index),
      other = locationAt(1 - index);
    if (!current || !other) return;
    const snapshot = snapshots.current[index];
    const entries =
      chosen ??
      (snapshot.selected.length
        ? snapshot.selected
        : snapshot.focused
          ? [snapshot.focused]
          : []);
    if (current.source.startsWith("zip:") && operation !== "copy") {
      notify(t.readOnly);
      return;
    }
    if (operation !== "mkdir" && !entries.length) {
      notify(t.selectFiles);
      return;
    }
    if (
      (operation === "zip" || operation === "extract") &&
      (current.source !== "local" || other.source !== "local")
    ) {
      notify(t.desktopOnly + " ZIP: local files only.");
      return;
    }
    const resolved =
      operation === "trash" && current.source !== "local"
        ? "delete"
        : operation;
    const destination = operation === "zip" ? current : other;
    setDialog({
      kind: "action",
      data: { operation: resolved, source: current, entries, destination },
    });
  }
  function contextActions(spec: NonNullable<typeof context>): MenuAction[] {
    const { entries, location, index } = spec;
    const one = entries.length === 1 ? entries[0] : undefined;
    const text = !!one && !one.isDir;
    const readOnly = location.source.startsWith("zip:");
    const menu: MenuAction[] = [
      {
        id: "open",
        label: t.open,
        icon: <Folder size={15} />,
        key: "Enter",
        disabled: !one,
        run: () => {
          if (one) open(one, index);
        },
      },
      {
        id: "view",
        label: t.preview,
        icon: <Eye size={15} />,
        key: "F3",
        disabled: !text,
        run: () => {
          if (one)
            setDialog({
              kind: "preview",
              location: { ...location, path: one.path },
            });
        },
      },
      {
        id: "edit",
        label: t.edit,
        icon: <FilePenLine size={15} />,
        key: "F4",
        disabled: !text || readOnly,
        run: () => {
          if (one)
            setDialog({
              kind: "edit",
              location: { ...location, path: one.path },
            });
        },
      },
      {
        id: "copy",
        label: t.copy,
        icon: <Copy size={15} />,
        key: "F5",
        separator: true,
        disabled: !entries.length,
        run: () => action("copy", index, entries),
      },
      {
        id: "clipboard-copy",
        label: t.copyClipboard,
        icon: <Copy size={15} />,
        key: "Ctrl+C",
        disabled: !entries.length,
        run: () => {
          void copyFiles(false, index, entries);
        },
      },
      {
        id: "clipboard-cut",
        label: t.cutClipboard,
        icon: <Scissors size={15} />,
        key: "Ctrl+X",
        disabled: !entries.length || readOnly,
        run: () => {
          void copyFiles(true, index, entries);
        },
      },
      {
        id: "clipboard-paste",
        label: t.paste,
        icon: <PasteIcon size={15} />,
        key: "Ctrl+V",
        disabled: !fileClipboard || readOnly,
        run: () => {
          void pasteFiles(index, location);
        },
      },
      {
        id: "copy-path",
        label: t.copyPath,
        icon: <Copy size={15} />,
        key: "Ctrl+Shift+C",
        run: () => {
          void copyPaths(index, entries, location);
        },
      },
      {
        id: "move",
        label: t.move,
        icon: <ArrowRight size={15} />,
        key: "F6",
        disabled: !entries.length || readOnly,
        run: () => action("move", index, entries),
      },
      {
        id: "rename",
        label: t.rename,
        icon: <FilePenLine size={15} />,
        key: "F2",
        disabled: !entries.length || readOnly,
        run: () =>
          setDialog({ kind: "rename", entries, source: location.source }),
      },
      {
        id: "trash",
        label: location.source === "local" ? t.trash : t.delete,
        icon: <X size={15} />,
        key: "F8",
        danger: true,
        disabled: !entries.length || readOnly,
        run: () => action("trash", index, entries),
      },
      {
        id: "properties",
        label: t.properties,
        icon: <Info size={15} />,
        key: "Alt+Enter",
        separator: true,
        run: () => properties(index, entries),
      },
      {
        id: "new-file",
        label: t.newFile,
        icon: <FilePenLine size={15} />,
        key: "Shift+F4",
        disabled: readOnly,
        run: () => newTextFile(location),
      },
      {
        id: "mkdir",
        label: t.mkdir,
        icon: <FolderPlus size={15} />,
        key: "F7",
        separator: true,
        disabled: readOnly,
        run: () => action("mkdir", index, []),
      },
      {
        id: "refresh",
        label: t.refresh,
        icon: <RefreshCw size={15} />,
        key: "Ctrl+R",
        run: () => paneControls.current[index]?.refresh(),
      },
      {
        id: "terminal",
        label: t.terminal,
        icon: <TerminalSquare size={15} />,
        key: "Ctrl+`",
        run: toggleTerminal,
      },
    ];
    return entries.length ? menu : menu.filter((a) => !a.disabled);
  }
  function rename() {
    if (!current) return;
    if (current.source.startsWith("zip:")) {
      notify(t.readOnly);
      return;
    }
    const s = snapshots.current[active];
    const entries = s.selected.length
      ? s.selected
      : s.focused
        ? [s.focused]
        : [];
    if (!entries.length) {
      notify(t.selectFiles);
      return;
    }
    setDialog({ kind: "rename", entries, source: current.source });
  }
  function selectedFile() {
    const s = snapshots.current[active];
    return s.focused || s.selected[0];
  }
  function preview() {
    const e = selectedFile();
    if (e && !e.isDir && current)
      setDialog({ kind: "preview", location: { ...current, path: e.path } });
    else notify(t.selectFiles);
  }
  function open(entry: Entry, index: number) {
    const s = settings!.panes[index];
    const location = s.tabs.find((t) => t.id === s.activeTab)!.location;
    if (entry.isDir) navigate({ ...location, path: entry.path }, index);
    else if (
      entry.name.toLowerCase().endsWith(".zip") &&
      location.source === "local"
    )
      navigate({ source: `zip:${entry.path}`, path: "/" }, index);
    else if (location.source === "local")
      api
        .command("open_file", { path: entry.path, edit: false })
        .catch((e) => notify(api.desktop ? String(e) : t.desktopOnly));
    else
      setDialog({
        kind: "preview",
        location: { ...location, path: entry.path },
      });
  }
  function edit() {
    const entry = selectedFile();
    if (!entry || entry.isDir || !current) {
      notify(t.selectFiles);
      return;
    }
    if (current.source.startsWith("zip:")) {
      notify(t.readOnly);
      return;
    }
    setDialog({ kind: "edit", location: { ...current, path: entry.path } });
  }
  function newTextFile(folder = locationAt(active)) {
    if (!folder) return;
    if (folder.source.startsWith("zip:")) {
      notify(t.readOnly);
      return;
    }
    setDialog({ kind: "edit", location: folder, newFile: true });
  }
  function properties(index = active, entries = chosenEntries(index)) {
    const location = locationAt(index);
    if (!location) return;
    setDialog({
      kind: "properties",
      location,
      entries: entries.length
        ? entries
        : [
            {
              name: basename(location.path),
              path: location.path,
              isDir: true,
              isSymlink: false,
              size: 0,
              modified: 0,
              hidden: false,
            },
          ],
    });
  }
  function toggleTerminal() {
    const source = ensureTerminal();
    if (!source) return;
    setTerminalView((v) =>
      v === "docked" && source === terminalSource ? "hidden" : "docked",
    );
  }
  function ensureTerminal() {
    if (!current) return;
    const location = current.source.startsWith("zip:")
      ? { source: "local", path: parent(current.source.slice(4)) }
      : current;
    const profile = [
      ...(catalog?.hosts.map((h) => h.profile) || []),
      ...sessions,
      ...(settings?.profiles || []),
    ].find((p) => `sftp:${p.id}` === location.source);
    const label =
      location.source === "local"
        ? location.path
        : profile
          ? `${profile.username}@${profile.host}:${profile.port}`
          : location.source;
    setTerminals((old) =>
      old[location.source]
        ? old
        : { ...old, [location.source]: { ...location, label } },
    );
    setTerminalSource(location.source);
    return location.source;
  }
  function toggleFullTerminal() {
    if (terminalView === "full") {
      setTerminalView(terminalReturnView.current);
      if (terminalReturnView.current === "hidden")
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLElement>(`[data-pane="${active}"] .file-grid`)
            ?.focus(),
        );
      return;
    }
    if (!ensureTerminal()) return;
    terminalReturnView.current = terminalView;
    setTerminalView("full");
  }
  function bookmarkFor(index = active): Bookmark | null {
    const location = locationAt(index);
    if (!location) return null;
    if (location.source.startsWith("zip:"))
      return {
        name:
          location.path === "/"
            ? basename(location.source.slice(4))
            : basename(location.path),
        path: location.path,
        source: location.source,
        kind: "bookmark",
      };
    if (location.source.startsWith("sftp:")) {
      const host = catalog?.hosts.find(
        (host) => `sftp:${host.profile.id}` === location.source,
      );
      const profile =
        host?.profile ||
        sessions.find((profile) => `sftp:${profile.id}` === location.source);
      if (!profile) return null;
      const target = host
        ? { ...profile, host: host.alias, username: "", port: 22 }
        : profile;
      return {
        name:
          basename(location.path) === "/"
            ? profile.name
            : basename(location.path),
        path: formatRemoteAddress(target, location.path),
        kind: "bookmark",
      };
    }
    return {
      name: basename(location.path),
      path: location.path,
      kind: "bookmark",
    };
  }
  function bookmark(index = active) {
    const value = bookmarkFor(index);
    if (!value) return;
    setSettings((settings) =>
      settings
        ? {
            ...settings,
            bookmarks: settings.bookmarks.some(
              (b) => bookmarkKey(b) === bookmarkKey(value),
            )
              ? settings.bookmarks.filter(
                  (b) => bookmarkKey(b) !== bookmarkKey(value),
                )
              : [...settings.bookmarks, value],
          }
        : settings,
    );
  }
  function removeBookmark(value: Bookmark) {
    setSettings((settings) =>
      settings
        ? {
            ...settings,
            bookmarks: settings.bookmarks.filter(
              (b) => bookmarkKey(b) !== bookmarkKey(value),
            ),
          }
        : settings,
    );
  }
  function openBookmark(value: Bookmark, index = activeRef.current) {
    closeDialog();
    setBookmarkMenu(undefined);
    setActive(index);
    navigate({ source: value.source || "local", path: value.path }, index);
    requestAnimationFrame(() => {
      if (!document.querySelector('[role="dialog"]'))
        document
          .querySelector<HTMLElement>(`[data-pane="${index}"] .file-grid`)
          ?.focus();
    });
  }
  function manageBookmarks(seed?: Bookmark | null) {
    const existing =
      seed &&
      settings?.bookmarks.find((b) => bookmarkKey(b) === bookmarkKey(seed));
    setDialog({ kind: "bookmarks", seed: existing || seed });
  }
  function disconnect(source: string) {
    api
      .command("disconnect_sftp", { source })
      .then(() => {
        remoteHomes.current.delete(source);
        setFileClipboard((value) => (value?.source === source ? null : value));
        clipboardRevision.current = -1;
        closedTabs.current = closedTabs.current.map((tabs) =>
          tabs.filter((tab) => tab.location.source !== source),
        );
        setTerminals((old) => {
          const next = { ...old };
          delete next[source];
          return next;
        });
        if (terminalSource === source) setTerminalView("hidden");
        setSettings((s) =>
          s && boot
            ? {
                ...s,
                panes: s.panes.map((p) => ({
                  ...p,
                  tabs: p.tabs.map((t) =>
                    t.location.source === source
                      ? {
                          ...t,
                          location: { source: "local", path: boot.home },
                          history: [{ source: "local", path: boot.home }],
                          historyIndex: 0,
                        }
                      : t,
                  ),
                })),
              }
            : s,
        );
      })
      .catch((e) => notify(String(e)));
  }
  const actions: PaletteAction[] = [
    {
      id: "compare",
      label: t.compareDirectories,
      icon: <ArrowDownUp size={16} />,
      key: "Shift+F2",
      run: compareDirectories,
    },
    {
      id: "properties",
      label: t.properties,
      icon: <Info size={16} />,
      key: "Alt+Enter",
      run: () => properties(),
    },
    {
      id: "bookmarks",
      label: t.manageBookmarks,
      icon: <Star size={16} />,
      key: "Ctrl+Shift+D",
      run: () => manageBookmarks(),
    },
    {
      id: "new-file",
      label: t.newFile,
      icon: <FilePenLine size={16} />,
      key: "Shift+F4",
      run: () => newTextFile(),
    },
    {
      id: "clipboard-copy",
      label: t.copyClipboard,
      icon: <Copy size={16} />,
      key: "Ctrl+C",
      run: () => {
        void copyFiles(false);
      },
    },
    {
      id: "clipboard-cut",
      label: t.cutClipboard,
      icon: <Scissors size={16} />,
      key: "Ctrl+X",
      run: () => {
        void copyFiles(true);
      },
    },
    {
      id: "clipboard-paste",
      label: t.paste,
      icon: <PasteIcon size={16} />,
      key: "Ctrl+V",
      run: () => {
        void pasteFiles();
      },
    },
    {
      id: "copy-path",
      label: t.copyPath,
      icon: <Copy size={16} />,
      key: "Ctrl+Shift+C",
      run: () => {
        void copyPaths();
      },
    },
    {
      id: "sshConfig",
      label: t.sshCatalog,
      icon: <FileCode2 size={16} />,
      run: () => setDialog({ kind: "sshConfig" }),
    },
    {
      id: "search",
      label: t.search,
      icon: <Search size={16} />,
      key: "Ctrl F",
      run: () => setDialog({ kind: "search" }),
    },
    {
      id: "recovery",
      label: t.recovery,
      icon: <History size={16} />,
      key: "Ctrl+Shift+R",
      run: () => openRecovery(),
    },
    {
      id: "mkdir",
      label: t.mkdir,
      icon: <FolderPlus size={16} />,
      key: "F7",
      run: () => action("mkdir"),
    },
    {
      id: "copy",
      label: t.copy,
      icon: <Copy size={16} />,
      key: "F5",
      run: () => action("copy"),
    },
    {
      id: "move",
      label: t.move,
      icon: <ArrowRight size={16} />,
      key: "F6",
      run: () => action("move"),
    },
    {
      id: "rename",
      label: t.rename,
      icon: <FilePenLine size={16} />,
      key: "F2",
      run: rename,
    },
    {
      id: "preview",
      label: t.preview,
      icon: <Eye size={16} />,
      key: "F3",
      run: preview,
    },
    {
      id: "edit",
      label: t.edit,
      icon: <FilePenLine size={16} />,
      key: "F4",
      run: edit,
    },
    {
      id: "trash",
      label: t.trash,
      icon: <X size={16} />,
      key: "F8",
      run: () => action("trash"),
    },
    {
      id: "refresh",
      label: t.refresh,
      icon: <RefreshCw size={16} />,
      key: "Ctrl+R",
      run: () => paneControls.current[active]?.refresh(),
    },
    {
      id: "location",
      label: t.goToPath,
      icon: <Folder size={16} />,
      key: "Ctrl+L",
      run: () => paneControls.current[active]?.path(),
    },
    {
      id: "selectAll",
      label: t.selectAll,
      icon: <Square size={16} />,
      key: "Ctrl+A",
      run: () => paneControls.current[active]?.all(),
    },
    {
      id: "invert",
      label: t.invertSelection,
      icon: <Square size={16} />,
      key: "Ctrl+I",
      run: () => paneControls.current[active]?.invert(),
    },
    {
      id: "selectPattern",
      label: t.selectPattern,
      icon: <Square size={16} />,
      key: "+",
      run: () => paneControls.current[active]?.pattern(),
    },
    {
      id: "deselectPattern",
      label: t.deselectPattern,
      icon: <Square size={16} />,
      key: "−",
      run: () => paneControls.current[active]?.pattern(true),
    },
    {
      id: "zip",
      label: t.zip,
      icon: <Archive size={16} />,
      run: () => action("zip"),
    },
    {
      id: "extract",
      label: t.extract,
      icon: <ArrowDownToLine size={16} />,
      run: () => action("extract"),
    },
    {
      id: "terminal",
      label: t.terminal,
      icon: <TerminalSquare size={16} />,
      key: "Ctrl `",
      run: toggleTerminal,
    },
    {
      id: "connect",
      label: t.connect,
      icon: <Cloud size={16} />,
      run: () => setDialog({ kind: "connect" }),
    },
    {
      id: "settings",
      label: t.settings,
      icon: <Settings2 size={16} />,
      run: () => setDialog({ kind: "settings" }),
    },
  ];
  if (current?.source.startsWith("sftp:"))
    actions.push(
      {
        id: "forward",
        label: t.forwarding,
        icon: <Cable size={16} />,
        run: () =>
          setDialog({
            kind: "forward",
            source: current.source,
            title:
              [
                ...(catalog?.hosts.map((h) => h.profile) || []),
                ...sessions,
                ...(settings?.profiles || []),
              ].find((p) => `sftp:${p.id}` === current.source)?.name || "SSH",
          }),
      },
      {
        id: "disconnect",
        label: t.disconnect,
        icon: <Cloud size={16} />,
        run: () => disconnect(current.source),
      },
    );
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        (e.target as HTMLElement).closest('[role="menu"]')
      )
        return;
      const ctrl = e.ctrlKey || e.metaKey;
      const modal = !!dialog || !!document.querySelector('[role="dialog"]');
      if (modal) {
        if (e.key === "F5" || (ctrl && e.key.toLowerCase() === "r"))
          e.preventDefault();
        return;
      }
      if (!dialog && ctrl && e.key.toLowerCase() === "o") {
        e.preventDefault();
        e.stopPropagation();
        toggleFullTerminal();
        return;
      }
      if (!dialog && ctrl && (e.key === "`" || e.code === "Backquote")) {
        e.preventDefault();
        toggleTerminal();
        return;
      }
      if ((e.target as HTMLElement).closest(".terminal-panel")) return;
      const name = e.key.toLowerCase();
      if ((ctrl && name === "l") || (e.altKey && !ctrl && name === "d")) {
        e.preventDefault();
        paneControls.current[active]?.path();
        return;
      }
      if (ctrl && name === "r" && e.shiftKey) {
        e.preventDefault();
        openRecovery();
        return;
      }
      if (ctrl && name === "r") {
        e.preventDefault();
        paneControls.current[active]?.refresh();
        return;
      }
      if (ctrl && name === "f" && e.shiftKey) {
        e.preventDefault();
        paneControls.current[active]?.filter();
        return;
      }
      if (
        (ctrl && e.key === "Tab") ||
        (ctrl && ["PageUp", "PageDown"].includes(e.key))
      ) {
        e.preventDefault();
        cycleTab(e.shiftKey || e.key === "PageUp" ? -1 : 1);
        return;
      }
      if (ctrl && name === "t" && e.shiftKey) {
        e.preventDefault();
        reopenTab();
        return;
      }
      if (ctrl && name === "t") {
        e.preventDefault();
        newTab();
        return;
      }
      if (ctrl && name === "w" && settings) {
        e.preventDefault();
        closeTab(settings.panes[active].activeTab, active);
        return;
      }
      if (ctrl && ["p", "k"].includes(name)) {
        e.preventDefault();
        setDialog({ kind: "palette" });
        return;
      }
      if (ctrl && name === "f") {
        e.preventDefault();
        setDialog({ kind: "search" });
        return;
      }
      if (e.key === "F2" && e.shiftKey && !ctrl && !e.altKey) {
        e.preventDefault();
        compareDirectories();
        return;
      }
      if (ctrl && e.key === ",") {
        e.preventDefault();
        setDialog({ kind: "settings" });
        return;
      }
      if (e.key === "F1" && !ctrl && !e.altKey) {
        e.preventDefault();
        setDialog({ kind: "shortcuts" });
        return;
      }
      if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        paneControls.current[active]?.up();
        return;
      }
      if (e.altKey && e.key === "Home" && current && boot) {
        e.preventDefault();
        navigate({
          source: current.source,
          path:
            current.source === "local"
              ? boot.home
              : remoteHomes.current.get(current.source) || "/",
        });
        return;
      }
      if (
        (e.target as HTMLElement).closest(
          "input,textarea,select,[contenteditable=true]",
        )
      )
        return;
      if (e.altKey && !ctrl && !e.shiftKey && e.key === "Enter") {
        e.preventDefault();
        properties();
        return;
      }
      if (ctrl && !e.altKey && name === "c" && e.shiftKey) {
        e.preventDefault();
        void copyPaths();
        return;
      }
      if (
        ctrl &&
        !e.altKey &&
        !e.shiftKey &&
        (name === "c" || e.key === "Insert")
      ) {
        e.preventDefault();
        void copyFiles(false);
        return;
      }
      if (ctrl && !e.altKey && !e.shiftKey && name === "x") {
        e.preventDefault();
        void copyFiles(true);
        return;
      }
      if (
        !e.altKey &&
        ((ctrl && !e.shiftKey && name === "v") ||
          (!ctrl && e.shiftKey && e.key === "Insert"))
      ) {
        e.preventDefault();
        void pasteFiles();
        return;
      }
      if (ctrl && e.key.toLowerCase() === "u" && settings) {
        e.preventDefault();
        update({ panes: [settings.panes[1], settings.panes[0]] });
      } else if (ctrl && e.key.toLowerCase() === "b" && settings) {
        e.preventDefault();
        update({ workspaceCollapsed: !settings.workspaceCollapsed });
      } else if (ctrl && e.key.toLowerCase() === "h" && settings) {
        e.preventDefault();
        update({ showHidden: !settings.showHidden });
      } else if (ctrl && !e.altKey && name === "d") {
        e.preventDefault();
        if (e.shiftKey) manageBookmarks();
        else bookmark();
      } else if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        history(-1, active);
      } else if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        history(1, active);
      } else if (e.key === "Tab") {
        e.preventDefault();
        const index = 1 - active;
        setActive(index);
        document
          .querySelector<HTMLElement>(`[data-pane="${index}"] .file-grid`)
          ?.focus();
      } else if (
        !ctrl &&
        !e.altKey &&
        (!e.shiftKey || ["F4", "F8", "Delete"].includes(e.key)) &&
        ["F2", "F3", "F4", "F5", "F6", "F7", "F8", "Delete"].includes(e.key)
      ) {
        e.preventDefault();
        const shortcuts: Record<string, () => void> = {
          F2: rename,
          F3: preview,
          F4: () => (e.shiftKey ? newTextFile() : edit()),
          F5: () => action("copy"),
          F6: () => action("move"),
          F7: () => action("mkdir"),
          F8: () => action(e.shiftKey ? "delete" : "trash"),
          Delete: () => action(e.shiftKey ? "delete" : "trash"),
        };
        shortcuts[e.key]?.();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });
  if (!boot || !settings || !current)
    return (
      <div className="boot-screen">
        <img src="/icon.svg" width="56" />
        <h1>SuperCommander</h1>
        {bootError ? (
          <>
            <p className="inline-error">{bootError}</p>
            <button className="primary" onClick={() => void initialize()}>
              {t.retry}
            </button>
          </>
        ) : (
          <LoaderCircle className="spin" size={20} />
        )}
      </div>
    );
  const running = jobs.filter((j) =>
    ["preparing", "queued", "running", "conflict"].includes(j.state),
  ).length;
  const placeIcons: Record<string, typeof Home> = {
    home: Home,
    desktop: Monitor,
    documents: BookOpen,
    downloads: Download,
    pictures: Image,
    music: Music2,
    videos: Video,
  };
  function connected(
    profile: SftpProfile,
    fingerprint: string,
    path: string,
    destination?: { pane: number; path: string },
  ) {
    setSessions((old) => [...old.filter((p) => p.id !== profile.id), profile]);
    setFileClipboard((value) =>
      value?.source === `sftp:${profile.id}` ? null : value,
    );
    clipboardRevision.current = -1;
    update({
      trustedHosts: {
        ...settings!.trustedHosts,
        [`${profile.host}:${profile.port}`]: fingerprint,
      },
    });
    remoteHomes.current.set(`sftp:${profile.id}`, path);
    navigate(
      { source: `sftp:${profile.id}`, path: destination?.path || path },
      destination?.pane ?? activeRef.current,
    );
    notify(t.connectionSaved);
  }
  async function saveProfile(
    profile: SftpProfile,
    secret: string,
    revision: string | null | undefined,
  ) {
    const current =
      catalogRef.current || (await api.readSshCatalog(settings?.sshConfigPath));
    const value = await api.command<SshCatalog>("save_ssh_host", {
      path: current.path,
      alias: profile.name || profile.host,
      profile,
      revision: revision === undefined ? current.revision : revision,
    });
    setCatalog(value);
    const entry = value.hosts.find(
      (h) =>
        h.alias.toLowerCase() === (profile.name || profile.host).toLowerCase(),
    );
    if (!entry) throw new Error("Saved SSH alias could not be loaded");
    update({
      sshConfigPath: value.path,
      profiles: settings!.profiles.filter((p) => p.id !== profile.id),
    });
    await api.command("save_connection_secret", {
      id: entry.profile.id,
      secret,
      remember: profile.saveSecret,
    });
    return {
      profile: { ...entry.profile, saveSecret: profile.saveSecret },
      revision: value.revision,
    };
  }
  function forget(id: string) {
    api
      .command("forget_secret", { id })
      .then(() =>
        update({ profiles: settings!.profiles.filter((p) => p.id !== id) }),
      )
      .catch((e) => notify(String(e)));
  }
  function openCatalogHost(host: CatalogHost) {
    const source = `sftp:${host.profile.id}`;
    const path = remoteHomes.current.get(source);
    if (path) navigate({ source, path });
    else setDialog({ kind: "connect", profile: host.profile });
  }
  function groupProps(id: string, title: string) {
    return {
      title,
      collapsed: settings!.collapsedGroups?.includes(id) || false,
      onToggle: () =>
        update({
          collapsedGroups: settings!.collapsedGroups?.includes(id)
            ? settings!.collapsedGroups.filter((g) => g !== id)
            : [...(settings!.collapsedGroups || []), id],
        }),
    };
  }
  async function refreshNetwork() {
    const data = await api.bootstrap();
    setBoot((old) =>
      old
        ? {
            ...old,
            drives: data.drives,
            network: data.network,
            networkError: data.networkError,
          }
        : data,
    );
    if (data.networkError) throw new Error(data.networkError);
  }
  const locations = networkLocations(settings, boot.network || []);
  return (
    <div
      className={`app-shell ${settings.glass ? "frosted" : "opaque"}`}
      data-theme={resolvedTheme}
      data-density={settings.density}
      data-workspace-collapsed={!!settings.workspaceCollapsed}
      style={
        {
          "--surface-opacity": settings.glass
            ? 1 - Math.max(0, Math.min(70, settings.transparency ?? 15)) / 100
            : 1,
        } as CSSProperties
      }
    >
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <img src="/icon.svg" alt="" />
          <strong data-tauri-drag-region>
            Super<span>Commander</span>
          </strong>
          <span className="version-pill">BETA</span>
        </div>
        <button
          className="global-search"
          onClick={() => setDialog({ kind: "palette" })}
        >
          <Search size={15} />
          <span>{t.searchHint}</span>
          <kbd>Ctrl K</kbd>
        </button>
        <WorkspaceTools
          t={t}
          hidden={settings.showHidden}
          terminal={terminalView !== "hidden"}
          onSwap={() =>
            update({ panes: [settings.panes[1], settings.panes[0]] })
          }
          onHidden={() => update({ showHidden: !settings.showHidden })}
          onTerminal={toggleTerminal}
          onSettings={() => setDialog({ kind: "settings" })}
          actions={actions}
        />
        <div className="window-controls">
          <button
            aria-label="Minimize"
            onClick={() => api.desktop && getCurrentWindow().minimize()}
          >
            <Minus size={14} />
          </button>
          <button
            aria-label="Maximize"
            onClick={() => api.desktop && getCurrentWindow().toggleMaximize()}
          >
            <Square size={11} />
          </button>
          <button
            aria-label={t.close}
            className="window-close"
            onClick={() => api.desktop && getCurrentWindow().close()}
          >
            <X size={15} />
          </button>
        </div>
      </header>
      <div className="application-body">
        <aside className="sidebar glass">
          <div className="workspace-label">
            <span className="workspace-mark">
              <LayoutGrid size={15} />
            </span>
            <div>
              <strong>{t.workspace}</strong>
              <small>SuperCommander</small>
            </div>
            <IconButton
              title={
                settings.workspaceCollapsed
                  ? t.expandWorkspace
                  : t.collapseWorkspace
              }
              shortcut="Ctrl+B"
              onClick={() =>
                update({ workspaceCollapsed: !settings.workspaceCollapsed })
              }
            >
              {settings.workspaceCollapsed ? (
                <PanelLeftOpen size={15} />
              ) : (
                <PanelLeftClose size={15} />
              )}
            </IconButton>
          </div>
          <div className="sidebar-scroll">
            <WorkspaceGroup {...groupProps("places", t.workspace)}>
              {boot.places.map((place) => {
                const Icon = placeIcons[place.kind] || Folder;
                return (
                  <button
                    key={place.path}
                    className={`sidebar-item ${current.source === "local" && current.path === place.path ? "active" : ""}`}
                    onClick={() =>
                      navigate({ source: "local", path: place.path })
                    }
                  >
                    <Icon size={16} />
                    <span>{t[place.name as "home"] || place.name}</span>
                    {current.path === place.path && (
                      <span className="active-dot" />
                    )}
                  </button>
                );
              })}
            </WorkspaceGroup>
            <WorkspaceGroup
              {...groupProps("favorites", t.favorites)}
              actions={
                <span className="catalog-buttons">
                  <button
                    data-tooltip={t.manageBookmarks}
                    data-shortcut="Ctrl+Shift+D"
                    aria-label={t.manageBookmarks}
                    onClick={() => manageBookmarks()}
                  >
                    <BookOpen size={13} />
                  </button>
                  <button
                    data-tooltip={t.addFavorite}
                    aria-label={t.addFavorite}
                    onClick={() => manageBookmarks(bookmarkFor())}
                  >
                    <Plus size={13} />
                  </button>
                </span>
              }
            >
              {!settings.bookmarks.length ? (
                <button
                  className="sidebar-item muted"
                  onClick={() => manageBookmarks(bookmarkFor())}
                >
                  <Star size={15} />
                  <span>{t.addFavorite}</span>
                </button>
              ) : (
                settings.bookmarks.map((b) => (
                  <button
                    className={`sidebar-item bookmark-item ${bookmarkFor() && bookmarkKey(bookmarkFor()!) === bookmarkKey(b) ? "active" : ""}`}
                    key={bookmarkKey(b)}
                    data-tooltip={`${b.name} · ${b.path}`}
                    onClick={() => openBookmark(b)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setContext(undefined);
                      setBookmarkMenu({
                        bookmark: b,
                        x: event.clientX,
                        y: event.clientY,
                      });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "F2") {
                        event.preventDefault();
                        manageBookmarks(b);
                      } else if (event.key === "Delete") {
                        event.preventDefault();
                        removeBookmark(b);
                      } else if (
                        event.key === "Enter" &&
                        (event.ctrlKey || event.metaKey)
                      ) {
                        event.preventDefault();
                        openBookmark(b, 1 - active);
                      } else if (
                        event.key === "ContextMenu" ||
                        (event.shiftKey && event.key === "F10")
                      ) {
                        event.preventDefault();
                        const rect =
                          event.currentTarget.getBoundingClientRect();
                        setContext(undefined);
                        setBookmarkMenu({
                          bookmark: b,
                          x: rect.right,
                          y: rect.top,
                        });
                      } else if (
                        ["ArrowUp", "ArrowDown", "Home", "End"].includes(
                          event.key,
                        )
                      ) {
                        event.preventDefault();
                        const buttons = Array.from(
                          event.currentTarget
                            .closest(".sidebar-group")!
                            .querySelectorAll<HTMLButtonElement>(
                              ".bookmark-item",
                            ),
                        );
                        const index = buttons.indexOf(event.currentTarget);
                        buttons[
                          event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? buttons.length - 1
                              : Math.max(
                                  0,
                                  Math.min(
                                    buttons.length - 1,
                                    index + (event.key === "ArrowUp" ? -1 : 1),
                                  ),
                                )
                        ]?.focus();
                      }
                    }}
                  >
                    <Star size={15} />
                    <span>{b.name}</span>
                  </button>
                ))
              )}
            </WorkspaceGroup>
            <WorkspaceGroup {...groupProps("devices", t.devices)}>
              {boot.drives
                .filter((d) => !boot.network?.some((n) => n.path === d.path))
                .map((drive) => (
                  <button
                    key={drive.path}
                    className="sidebar-item drive-item"
                    onClick={() =>
                      navigate({ source: "local", path: drive.path })
                    }
                  >
                    <HardDrive size={16} />
                    <span>
                      {drive.name}
                      <small>{drive.path}</small>
                    </span>
                  </button>
                ))}
            </WorkspaceGroup>
            <WorkspaceGroup
              {...groupProps("network", t.network)}
              actions={
                <span className="catalog-buttons">
                  <button
                    data-tooltip={t.refreshExplorer}
                    aria-label={t.refresh}
                    onClick={() => {
                      void refreshNetwork().catch((e) => notify(String(e)));
                    }}
                  >
                    <RefreshCw size={12} />
                  </button>
                  <button
                    data-tooltip={t.networkLocations}
                    aria-label={t.networkLocations}
                    onClick={() => setDialog({ kind: "network" })}
                  >
                    <Plus size={13} />
                  </button>
                </span>
              }
            >
              {locations.map((place) => (
                <button
                  className={`sidebar-item ${current.source === "local" && current.path === place.path ? "active" : ""}`}
                  key={place.path}
                  data-tooltip={`${place.name} · ${place.path}`}
                  onClick={() =>
                    navigate({ source: "local", path: place.path })
                  }
                >
                  <Wifi size={15} />
                  <span>{place.name}</span>
                </button>
              ))}
              {!locations.length && (
                <p className="sidebar-empty">
                  {boot.networkError || t.networkEmpty}
                </p>
              )}
            </WorkspaceGroup>
            <WorkspaceGroup
              {...groupProps("connections", t.connections)}
              actions={
                <span className="catalog-buttons">
                  <button
                    data-tooltip={t.sshCatalog}
                    aria-label={t.sshCatalog}
                    onClick={() => setDialog({ kind: "sshConfig" })}
                  >
                    <FileCode2 size={13} />
                  </button>
                  <button
                    data-tooltip={t.connect}
                    aria-label={t.connect}
                    onClick={() => setDialog({ kind: "sshConfig", add: true })}
                  >
                    <Plus size={13} />
                  </button>
                </span>
              }
            >
              {catalog?.hosts.map((host) => (
                <button
                  className={`sidebar-item ${current.source === `sftp:${host.profile.id}` ? "active" : ""}`}
                  disabled={host.disabled}
                  data-tooltip={[
                    `${host.profile.username}@${host.profile.host}:${host.profile.port}`,
                    ...host.warnings,
                  ].join("\n")}
                  key={host.profile.id}
                  onClick={() => openCatalogHost(host)}
                >
                  <ServerIcon />
                  <span>{host.alias}</span>
                </button>
              ))}
              {[
                ...settings.profiles,
                ...sessions.filter(
                  (p) => !settings.profiles.some((old) => old.id === p.id),
                ),
              ]
                .filter((p) => !p.id.startsWith("config-"))
                .map((p) => (
                  <button
                    key={p.id}
                    className="sidebar-item"
                    onClick={() => {
                      const source = `sftp:${p.id}`;
                      const path = remoteHomes.current.get(source);
                      if (path) navigate({ source, path });
                      else setDialog({ kind: "connect", profile: p });
                    }}
                  >
                    <ServerIcon />
                    <span>{p.name}</span>
                  </button>
                ))}
              <button
                className="sidebar-item muted"
                onClick={() => setDialog({ kind: "connect" })}
              >
                <Cloud size={16} />
                <span>{t.connect}</span>
                <Plus size={12} />
              </button>
            </WorkspaceGroup>
          </div>
          <div className="sidebar-bottom">
            <button
              className="sidebar-item"
              onClick={() => setDialog({ kind: "settings" })}
            >
              <Settings2 size={16} />
              <span>{t.settings}</span>
              <kbd>Ctrl+,</kbd>
            </button>
            <div className="local-status">
              <span className="status-led" />
              <span>{api.desktop ? t.local : t.demo}</span>
              <LockIcon />
            </div>
          </div>
        </aside>
        <main className="main-workspace">
          <h1 className="sr-only">SuperCommander</h1>
          <div
            ref={layout}
            className="pane-layout"
            hidden={terminalView === "full"}
            style={{
              gridTemplateColumns: `minmax(0,${split}fr) 11px minmax(0,${100 - split}fr)`,
            }}
          >
            {settings.panes
              .map((state, index) => (
                <FilePane
                  controls={(handle) => {
                    paneControls.current[index] = handle;
                  }}
                  key={index}
                  index={index}
                  state={state}
                  active={active === index}
                  settings={settings}
                  clipboard={fileClipboard}
                  bookmarked={
                    !!bookmarkFor(index) &&
                    settings.bookmarks.some(
                      (b) =>
                        bookmarkKey(b) === bookmarkKey(bookmarkFor(index)!),
                    )
                  }
                  onCancelCut={() => {
                    void cancelCut();
                  }}
                  profiles={[
                    ...sessions,
                    ...(catalog?.hosts.map((h) => h.profile) || []),
                    ...settings.profiles,
                  ]}
                  t={t}
                  refresh={refresh}
                  activate={() => setActive(index)}
                  navigate={(l) => navigate(l, index)}
                  history={(d) => history(d, index)}
                  newTab={() => newTab(index)}
                  closeTab={(id) => closeTab(id, index)}
                  selectTab={(id) =>
                    update({
                      panes: settings.panes.map((p, i) =>
                        i === index ? { ...p, activeTab: id } : p,
                      ),
                    })
                  }
                  onSelection={(s) => {
                    snapshots.current[index] = s;
                  }}
                  onOpen={(e) => open(e, index)}
                  onBookmark={() => bookmark(index)}
                  onContext={(entries, location, position) => {
                    setActive(index);
                    setContext({ index, entries, location, position });
                  }}
                  onError={notify}
                  onDrop={(destination, paths, source, move) => {
                    void enqueue({
                      id: uid(),
                      operation: move ? "move" : "copy",
                      source,
                      paths,
                      destination,
                      conflict: "ask",
                    }).catch((e) => notify(String(e)));
                  }}
                />
              ))
              .flatMap((element, i) =>
                i === 0
                  ? [
                      element,
                      <div
                        key="splitter"
                        className="pane-splitter"
                        role="separator"
                        aria-label={t.swap}
                        aria-orientation="vertical"
                        aria-valuenow={split}
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "ArrowLeft")
                            setSplit((n) => Math.max(28, n - 2));
                          if (e.key === "ArrowRight")
                            setSplit((n) => Math.min(72, n + 2));
                        }}
                        onPointerDown={(e) => {
                          e.currentTarget.setPointerCapture(e.pointerId);
                        }}
                        onPointerMove={(e) => {
                          if (
                            e.currentTarget.hasPointerCapture(e.pointerId) &&
                            layout.current
                          ) {
                            const bounds =
                              layout.current.getBoundingClientRect();
                            setSplit(
                              Math.max(
                                28,
                                Math.min(
                                  72,
                                  ((e.clientX - bounds.left) / bounds.width) *
                                    100,
                                ),
                              ),
                            );
                          }
                        }}
                      >
                        <span />
                      </div>,
                    ]
                  : [element],
              )}
          </div>
          {Object.values(terminals).map((terminal) => (
            <TerminalPanel
              key={terminal.source}
              path={terminal.path}
              source={terminal.source}
              label={terminal.label}
              t={t}
              theme={resolvedTheme}
              hidden={
                terminalView === "hidden" || terminalSource !== terminal.source
              }
              fullscreen={terminalView === "full"}
              onToggleFullscreen={toggleFullTerminal}
              onClose={() => {
                setTerminals((old) => {
                  const next = { ...old };
                  delete next[terminal.source];
                  return next;
                });
                setTerminalView("hidden");
              }}
            />
          ))}
          {queueOpen && terminalView !== "full" && (
            <QueuePanel
              jobs={jobs}
              t={t}
              onClose={() => setQueueOpen(false)}
              onClear={() =>
                setJobs((j) =>
                  j.filter((x) =>
                    ["preparing", "running", "queued", "conflict"].includes(
                      x.state,
                    ),
                  ),
                )
              }
              onError={notify}
              onRecovery={(location, key) => openRecovery(location, key)}
            />
          )}
          <div className="shortcut-bar" hidden={terminalView === "full"}>
            {[
              ["F2", t.rename, rename],
              ["F3", t.preview, preview],
              ["F4", t.edit, edit],
              ["F5", t.copy, () => action("copy")],
              ["F6", t.move, () => action("move")],
              ["F7", t.mkdir, () => action("mkdir")],
              ["F8", t.delete, () => action("trash")],
            ].map(([key, label, run]) => (
              <button
                key={String(key)}
                data-tooltip={label as string}
                data-shortcut={key as string}
                onClick={run as () => void}
              >
                <kbd>{key as string}</kbd>
                <span>{label as string}</span>
              </button>
            ))}
            <IconButton
              title={t.keyboard}
              shortcut="F1"
              onClick={() => setDialog({ kind: "shortcuts" })}
            >
              <Keyboard size={16} />
            </IconButton>
          </div>
        </main>
      </div>
      <footer className="statusbar">
        {clipboardProgress ? (
          <div className="clipboard-check" role="status">
            <LoaderCircle size={12} className="spin" />
            <span>
              {t.checkingClipboard} {basename(clipboardProgress.current)}
              {clipboardProgress.bytes > 0 &&
                ` · ${size(clipboardProgress.bytes)}`}
            </span>
            <IconButton
              title={t.cancelClipboardCheck}
              shortcut="Esc"
              onClick={cancelClipboardCheck}
            >
              <X size={12} />
            </IconButton>
          </div>
        ) : (
          <span>
            <span className="status-led" />
            {api.desktop ? t.ready : t.demoHint}
          </span>
        )}
        <div>
          <button onClick={() => setQueueOpen((v) => !v)}>
            <ArrowDownUp size={12} />
            {t.queue}
            {running > 0 && <span className="count-badge">{running}</span>}
          </button>
          <span className="status-divider" />
          <button
            onClick={() =>
              update({ language: settings.language === "en" ? "et" : "en" })
            }
          >
            {settings.language === "en" ? "EN" : "ET"}
          </button>
          <span className="status-divider" />
          <span>v{version}</span>
        </div>
      </footer>
      {toast && (
        <div className="toast glass" role="status">
          <span>{toast}</span>
          <IconButton title={t.close} onClick={() => setToast("")}>
            <X size={14} />
          </IconButton>
        </div>
      )}
      {dialog?.kind === "action" && (
        <ActionDialog
          data={dialog.data}
          t={t}
          onClose={closeDialog}
          onDone={() => setRefresh((n) => n + 1)}
          onSubmit={enqueue}
        />
      )}
      {dialog?.kind === "rename" && (
        <RenameDialog
          entries={dialog.entries}
          source={dialog.source}
          t={t}
          onClose={closeDialog}
          onDone={() => setRefresh((n) => n + 1)}
        />
      )}
      {dialog?.kind === "preview" && (
        <PreviewDialog
          location={dialog.location}
          initialLine={dialog.line}
          initialColumn={dialog.column}
          connection={dialog.connection}
          t={t}
          onClose={closeDialog}
          onEdit={
            dialog.location.source.startsWith("zip:")
              ? undefined
              : (line, column, connection) =>
                  setDialog({
                    kind: "edit",
                    location: dialog.location,
                    line: line || dialog.line,
                    column: column || dialog.column,
                    connection,
                  })
          }
        />
      )}
      {dialog?.kind === "edit" && (
        <TextWorkbench
          location={dialog.location}
          t={t}
          editable
          newFile={dialog.newFile}
          initialLine={dialog.line}
          initialColumn={dialog.column}
          connection={dialog.connection}
          destinations={[
            { source: "local", folder: boot.home, label: t.local },
            ...sessions
              .filter((profile) =>
                remoteHomes.current.has(`sftp:${profile.id}`),
              )
              .map((profile) => ({
                source: `sftp:${profile.id}`,
                folder: remoteHomes.current.get(`sftp:${profile.id}`)!,
                label: `${profile.name} · ${profile.username}@${profile.host}:${profile.port}`,
              })),
          ]}
          onClose={closeDialog}
          onSaved={() => setRefresh((v) => v + 1)}
        />
      )}
      {dialog?.kind === "search" && (
        <SearchDialog
          location={current}
          t={t}
          showHidden={settings.showHidden}
          onSaved={() => setRefresh((value) => value + 1)}
          onClose={closeDialog}
          destinations={[
            { source: "local", folder: boot.home, label: t.local },
            ...sessions
              .filter((profile) =>
                remoteHomes.current.has(`sftp:${profile.id}`),
              )
              .map((profile) => ({
                source: `sftp:${profile.id}`,
                folder: remoteHomes.current.get(`sftp:${profile.id}`)!,
                label: `${profile.name} · ${profile.username}@${profile.host}:${profile.port}`,
              })),
          ]}
          onAction={async (hit, action, connection) => {
            const location = { ...current, path: hit.entry.path };
            if (api.desktop) {
              const info = await api.properties(location);
              if (connection !== info.connection)
                throw new Error(
                  "The connection changed. Run the search again.",
                );
            }
            if (action === "view" || action === "edit") {
              return;
            } else {
              const index = action === "other" ? 1 - active : active;
              const folder = {
                ...current,
                path: hit.entry.isDir ? hit.entry.path : parent(hit.entry.path),
              };
              if (hit.entry.hidden && !settings.showHidden)
                update({ showHidden: true });
              closeDialog();
              setActive(index);
              if (!hit.entry.isDir)
                paneControls.current[index]?.reveal(folder, hit.entry.path);
              navigate(folder, index);
            }
          }}
        />
      )}
      {dialog?.kind === "settings" && (
        <SettingsDialog
          settings={settings}
          t={t}
          update={update}
          onClose={closeDialog}
          onShortcuts={() => setDialog({ kind: "shortcuts" })}
        />
      )}
      {dialog?.kind === "recovery" && (
        <RecoveryDialog
          location={dialog.location}
          selectedKey={dialog.selectedKey}
          other={locationAt(1 - active)}
          label={comparisonLabel(dialog.location)}
          otherLabel={
            locationAt(1 - active) && comparisonLabel(locationAt(1 - active)!)
          }
          density={settings.density}
          t={t}
          onClose={closeDialog}
          onReveal={(location) => {
            closeDialog();
            navigate(location);
          }}
          onQueue={async (id, operation, source, item, review) => {
            setJobs((old) => [
              ...old,
              {
                id,
                operation,
                count: review?.summary.rows.length || 1,
                state: "queued",
                current: item.original || item.payload,
                bytes: 0,
                total: 0,
                completed: 0,
                errors: [],
              },
            ]);
            setQueueOpen(true);
            try {
              if (operation === "restore" && review)
                await api.command("enqueue_recovery", { id, plan: review.id });
              else await api.command("remove_recovery", { id, source, item });
            } catch (error) {
              setJobs((old) =>
                old.map((job) =>
                  job.id === id
                    ? {
                        ...job,
                        state: String(error).includes("Cancelled")
                          ? "cancelled"
                          : "failed",
                        errors: [String(error)],
                      }
                    : job,
                ),
              );
              throw error;
            }
          }}
        />
      )}
      {dialog?.kind === "comparison" && (
        <ComparisonDialog
          left={dialog.left}
          right={dialog.right}
          showHidden={settings.showHidden}
          density={settings.density}
          initialSide={active}
          labels={[comparisonLabel(dialog.left), comparisonLabel(dialog.right)]}
          t={t}
          onClose={closeDialog}
          onSaved={() => setRefresh((value) => value + 1)}
          destinations={[
            {
              source: dialog.left.source,
              folder: dialog.left.path,
              label: t.leftSide,
            },
            {
              source: dialog.right.source,
              folder: dialog.right.path,
              label: t.rightSide,
            },
          ].filter(
            (destination, index, all) =>
              all.findIndex((other) => other.source === destination.source) ===
              index,
          )}
          onReveal={(side, location) => {
            closeDialog();
            setActive(side);
            navigate(location, side);
          }}
          onQueue={async (id, comparison, choices) => {
            setJobs((old) => [
              ...old,
              {
                id,
                operation: "synchronize",
                count: choices.length,
                state: "queued",
                current: dialog.left.path,
                bytes: 0,
                total: 0,
                completed: 0,
                errors: [],
              },
            ]);
            setQueueOpen(true);
            try {
              await api.command("enqueue_comparison", {
                id,
                comparison,
                choices,
              });
            } catch (error) {
              setJobs((old) =>
                old.map((job) =>
                  job.id === id
                    ? {
                        ...job,
                        state: String(error).includes("Cancelled")
                          ? "cancelled"
                          : "failed",
                        errors: String(error).includes("Cancelled")
                          ? []
                          : [String(error)],
                      }
                    : job,
                ),
              );
              throw error;
            }
          }}
        />
      )}
      {dialog?.kind === "shortcuts" && (
        <ShortcutsDialog t={t} onClose={closeDialog} />
      )}
      {dialog?.kind === "network" && (
        <NetworkDialog
          settings={settings}
          detected={boot.network || []}
          t={t}
          update={update}
          onClose={closeDialog}
          onRefresh={refreshNetwork}
          onOpen={(path) => {
            navigate({ source: "local", path });
            closeDialog();
          }}
        />
      )}
      {dialog?.kind === "bookmarks" && (
        <BookmarksDialog
          settings={settings}
          seed={dialog.seed}
          t={t}
          update={update}
          onClose={closeDialog}
          onOpen={openBookmark}
        />
      )}
      {dialog?.kind === "connect" && (
        <ConnectDialog
          profile={dialog.profile}
          settings={settings}
          t={t}
          onClose={closeDialog}
          onConnected={(profile, fingerprint, path, forwardErrors) => {
            connected(profile, fingerprint, path, dialog.destination);
            if (forwardErrors.length)
              notify(`${t.forwarding}: ${forwardErrors.join("; ")}`);
          }}
          onForget={forget}
          configRevision={catalog?.revision}
          onSaveProfile={saveProfile}
        />
      )}
      {dialog?.kind === "palette" && (
        <Palette actions={actions} t={t} onClose={closeDialog} />
      )}
      {dialog?.kind === "sshConfig" && (
        <SshCatalogDialog
          path={settings.sshConfigPath || catalog?.path}
          add={dialog.add}
          t={t}
          onClose={closeDialog}
          onUse={(value) => {
            setCatalog(value);
            update({ sshConfigPath: value.path });
          }}
        />
      )}
      {dialog?.kind === "forward" && (
        <ForwardDialog
          source={dialog.source}
          title={dialog.title}
          catalog={catalog}
          onCatalog={setCatalog}
          onSaveConnection={() =>
            setDialog({
              kind: "connect",
              profile: sessions.find((p) => `sftp:${p.id}` === dialog.source),
            })
          }
          t={t}
          onClose={closeDialog}
        />
      )}
      <Tooltips />
      {dialog?.kind === "properties" && (
        <PropertiesDialog
          location={dialog.location}
          entries={dialog.entries}
          t={t}
          onClose={closeDialog}
          onChanged={() => setRefresh((v) => v + 1)}
        />
      )}
      {bookmarkMenu && (
        <Menu
          label={t.bookmarkActions}
          anchor={{ x: bookmarkMenu.x, y: bookmarkMenu.y }}
          theme={resolvedTheme}
          onClose={() => setBookmarkMenu(undefined)}
          actions={[
            {
              id: "open",
              label: t.open,
              key: "Enter",
              icon: <Star size={15} />,
              run: () => openBookmark(bookmarkMenu.bookmark),
            },
            {
              id: "other",
              label: t.openOtherPane,
              key: "Ctrl+Enter",
              icon: <ArrowRight size={15} />,
              run: () => openBookmark(bookmarkMenu.bookmark, 1 - active),
            },
            {
              id: "edit",
              label: t.edit,
              key: "F2",
              icon: <FilePenLine size={15} />,
              run: () => manageBookmarks(bookmarkMenu.bookmark),
            },
            {
              id: "remove",
              label: t.removeFavorite,
              key: "Delete",
              danger: true,
              icon: <X size={15} />,
              run: () => removeBookmark(bookmarkMenu.bookmark),
            },
          ]}
        />
      )}
      {context && (
        <Menu
          label={t.fileActions}
          anchor={context.position}
          theme={resolvedTheme}
          onClose={() => setContext(undefined)}
          actions={contextActions(context)}
        />
      )}
    </div>
  );
}
function ServerIcon() {
  return <Cloud size={16} />;
}
function WorkspaceGroup({
  title,
  collapsed,
  onToggle,
  actions,
  children,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="sidebar-group">
      <h2>
        <button
          className="group-toggle"
          aria-label={title}
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <ChevronDown
            size={11}
            className={collapsed ? "group-collapsed" : ""}
          />
          <span>{title}</span>
        </button>
        {actions}
      </h2>
      <div hidden={collapsed}>{children}</div>
    </section>
  );
}
function LockIcon() {
  return (
    <span className="local-lock">
      <Wifi size={11} />
    </span>
  );
}
