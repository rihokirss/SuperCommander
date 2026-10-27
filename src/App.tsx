import { useCallback, useEffect, useRef, useState } from "react";
import { version } from "../package.json";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowDownUp,
  Archive,
  BookOpen,
  ChevronDown,
  Cloud,
  Copy,
  Download,
  Eye,
  FilePenLine,
  FileCode2,
  Cable,
  Folder,
  FolderPlus,
  HardDrive,
  Home,
  Image,
  Keyboard,
  LayoutGrid,
  LoaderCircle,
  Minus,
  Monitor,
  Music2,
  Plus,
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
import { basename, pane, tab, uid } from "./utils";
import { FilePane, type PaneSnapshot } from "./components/FilePane";
import { IconButton } from "./components/Primitives";
import {
  ActionDialog,
  ConnectDialog,
  Palette,
  RenameDialog,
  SearchDialog,
  SettingsDialog,
  type ActionData,
  type PaletteAction,
} from "./components/Dialogs";
import { PreviewDialog } from "./components/PreviewDialog";
import { QueuePanel } from "./components/QueuePanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { WorkspaceTools } from "./components/WorkspaceTools";
import { parseRemoteAddress } from "./address";
import { ForwardDialog, SshCatalogDialog } from "./components/SshTools";
import { Tooltips } from "./components/Tooltips";
import type {
  Bootstrap,
  Entry,
  Job,
  JobRequest,
  Location,
  Operation,
  Settings,
  SftpProfile,
  SshCatalog,
  CatalogHost,
} from "./types";

type Dialog =
  | { kind: "action"; data: ActionData }
  | { kind: "rename"; entries: Entry[]; source: string }
  | { kind: "preview"; location: Location }
  | {
      kind: "connect";
      profile?: SftpProfile;
      destination?: { pane: number; path: string };
    }
  | { kind: "sshConfig"; add?: boolean }
  | { kind: "forward"; source: string; title: string }
  | { kind: "settings" | "search" | "palette" };
const emptySnapshot: PaneSnapshot = { entries: [], selected: [] };
export function App() {
  const [boot, setBoot] = useState<Bootstrap>();
  const [settings, setSettings] = useState<Settings>();
  const [bootError, setBootError] = useState("");
  const [active, setActive] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [dialog, setDialog] = useState<Dialog>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [queueOpen, setQueueOpen] = useState(false);
  const [terminal, setTerminal] = useState<string>();
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
  const remoteHomes = useRef(new Map<string, string>());
  const [catalog, setCatalog] = useState<SshCatalog>();
  const [sessions, setSessions] = useState<SftpProfile[]>([]);
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
  const other = settings?.panes[1 - active].tabs.find(
    (x) => x.id === settings.panes[1 - active].activeTab,
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
      if (["completed", "failed", "cancelled"].includes(event.state))
        setRefresh((n) => n + 1);
    });
    return () => {
      subscription.then((fn) => fn());
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
        const profiles = (stateRef.current?.profiles || []).filter(
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
  async function enqueue(request: JobRequest) {
    const job: Job = {
      id: request.id,
      operation: request.operation,
      count: request.paths.length,
      state: "queued",
      current: "",
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
  function action(operation: Operation | "mkdir") {
    if (!current || !other) return;
    const snapshot = snapshots.current[active];
    const entries = snapshot.selected.length
      ? snapshot.selected
      : snapshot.focused
        ? [snapshot.focused]
        : [];
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
  function rename() {
    if (!current) return;
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
    if (!entry || !current) {
      notify(t.selectFiles);
      return;
    }
    if (current.source !== "local") {
      preview();
      return;
    }
    api
      .command("open_file", { path: entry.path, edit: true })
      .catch((e) => notify(String(e)));
  }
  function toggleTerminal() {
    if (!terminal && current?.source !== "local") {
      notify(t.localTerminal);
      return;
    }
    if (!terminal) setTerminal(current!.path);
    setTerminalView((v) => (v === "docked" ? "hidden" : "docked"));
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
    if (!terminal && current?.source !== "local") {
      notify(t.localTerminal);
      return;
    }
    if (!terminal) setTerminal(current!.path);
    terminalReturnView.current = terminalView;
    setTerminalView("full");
  }
  function bookmark(index = active) {
    if (!settings) return;
    const p = settings.panes[index];
    const location = p.tabs.find((t) => t.id === p.activeTab)!.location;
    if (location.source !== "local") return;
    update({
      bookmarks: settings.bookmarks.some((b) => b.path === location.path)
        ? settings.bookmarks.filter((b) => b.path !== location.path)
        : [
            ...settings.bookmarks,
            {
              name: basename(location.path),
              path: location.path,
              kind: "bookmark",
            },
          ],
    });
  }
  function disconnect(source: string) {
    api
      .command("disconnect_sftp", { source })
      .then(() => {
        remoteHomes.current.delete(source);
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
              settings?.profiles.find((p) => `sftp:${p.id}` === current.source)
                ?.name || "SSH",
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
      const ctrl = e.ctrlKey || e.metaKey;
      if (!dialog && ctrl && e.key.toLowerCase() === "o") {
        e.preventDefault();
        e.stopPropagation();
        toggleFullTerminal();
        return;
      }
      if (!dialog && ctrl && e.key === "`") {
        e.preventDefault();
        toggleTerminal();
        return;
      }
      if (
        dialog ||
        (e.target as HTMLElement).closest(
          "input,textarea,select,.terminal-panel",
        )
      )
        return;
      if (ctrl && ["p", "k"].includes(e.key.toLowerCase())) {
        e.preventDefault();
        setDialog({ kind: "palette" });
      } else if (ctrl && e.key.toLowerCase() === "u" && settings) {
        e.preventDefault();
        update({ panes: [settings.panes[1], settings.panes[0]] });
      } else if (ctrl && e.key.toLowerCase() === "h" && settings) {
        e.preventDefault();
        update({ showHidden: !settings.showHidden });
      } else if ((ctrl && e.key === ",") || e.key === "F1") {
        e.preventDefault();
        setDialog({ kind: "settings" });
      } else if (ctrl && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setDialog({ kind: "search" });
      } else if (ctrl && e.key.toLowerCase() === "t") {
        e.preventDefault();
        newTab();
      } else if (ctrl && e.key.toLowerCase() === "w" && settings) {
        e.preventDefault();
        closeTab(settings.panes[active].activeTab, active);
      } else if (ctrl && e.key === "`") {
        e.preventDefault();
        toggleTerminal();
      } else if (e.key === "Tab") {
        e.preventDefault();
        const index = 1 - active;
        setActive(index);
        document
          .querySelector<HTMLElement>(`[data-pane="${index}"] .file-grid`)
          ?.focus();
      } else if (
        ["F2", "F3", "F4", "F5", "F6", "F7", "F8", "Delete"].includes(e.key)
      ) {
        e.preventDefault();
        const shortcuts: Record<string, () => void> = {
          F2: rename,
          F3: preview,
          F4: edit,
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
    ["queued", "running", "conflict"].includes(j.state),
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
  return (
    <div
      className={`app-shell ${settings.glass ? "frosted" : "opaque"}`}
      data-theme={resolvedTheme}
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
            <ChevronDown size={13} />
          </div>
          <div className="sidebar-scroll">
            <div className="sidebar-group">
              <h2>{t.workspace}</h2>
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
            </div>
            <div className="sidebar-group">
              <h2>
                {t.favorites}
                <button
                  title={t.addFavorite}
                  aria-label={t.addFavorite}
                  onClick={() => bookmark()}
                >
                  <Plus size={13} />
                </button>
              </h2>
              {!settings.bookmarks.length ? (
                <button
                  className="sidebar-item muted"
                  onClick={() => bookmark()}
                >
                  <Star size={15} />
                  <span>{t.addFavorite}</span>
                </button>
              ) : (
                settings.bookmarks.map((b) => (
                  <button
                    className={`sidebar-item ${current.path === b.path ? "active" : ""}`}
                    key={b.path}
                    onClick={() => navigate({ source: "local", path: b.path })}
                  >
                    <Star size={15} />
                    <span>{b.name}</span>
                  </button>
                ))
              )}
            </div>
            <div className="sidebar-group">
              <h2>{t.devices}</h2>
              {boot.drives.map((drive) => (
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
            </div>
            <div className="sidebar-group">
              <h2>
                {t.connections}
                <span className="catalog-buttons">
                  <button
                    title={t.sshCatalog}
                    aria-label={t.sshCatalog}
                    onClick={() => setDialog({ kind: "sshConfig" })}
                  >
                    <FileCode2 size={13} />
                  </button>
                  <button
                    title={t.connect}
                    aria-label={t.connect}
                    onClick={() => setDialog({ kind: "sshConfig", add: true })}
                  >
                    <Plus size={13} />
                  </button>
                </span>
              </h2>
              {catalog?.hosts.map((host) => (
                <button
                  className={`sidebar-item ${current.source === `sftp:${host.profile.id}` ? "active" : ""}`}
                  disabled={host.disabled}
                  title={[
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
            </div>
          </div>
          <div className="sidebar-bottom">
            <button
              className="sidebar-item"
              onClick={() => setDialog({ kind: "settings" })}
            >
              <Settings2 size={16} />
              <span>{t.settings}</span>
              <kbd>⌘</kbd>
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
                  key={index}
                  index={index}
                  state={state}
                  active={active === index}
                  settings={settings}
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
          {terminal && (
            <TerminalPanel
              path={terminal}
              t={t}
              theme={resolvedTheme}
              hidden={terminalView === "hidden"}
              fullscreen={terminalView === "full"}
              onToggleFullscreen={toggleFullTerminal}
              onClose={() => {
                setTerminal(undefined);
                setTerminalView("hidden");
              }}
            />
          )}
          {queueOpen && terminalView !== "full" && (
            <QueuePanel
              jobs={jobs}
              t={t}
              onClose={() => setQueueOpen(false)}
              onClear={() =>
                setJobs((j) =>
                  j.filter((x) =>
                    ["running", "queued", "conflict"].includes(x.state),
                  ),
                )
              }
              onError={notify}
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
              onClick={() => setDialog({ kind: "settings" })}
            >
              <Keyboard size={16} />
            </IconButton>
          </div>
        </main>
      </div>
      <footer className="statusbar">
        <span>
          <span className="status-led" />
          {api.desktop ? t.ready : t.demoHint}
        </span>
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
        <PreviewDialog location={dialog.location} t={t} onClose={closeDialog} />
      )}
      {dialog?.kind === "search" && (
        <SearchDialog
          location={current}
          t={t}
          showHidden={settings.showHidden}
          onClose={closeDialog}
          onNavigate={navigate}
        />
      )}
      {dialog?.kind === "settings" && (
        <SettingsDialog
          settings={settings}
          t={t}
          update={update}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "connect" && (
        <ConnectDialog
          profile={dialog.profile}
          settings={settings}
          t={t}
          onClose={closeDialog}
          onConnected={(profile, fingerprint, path) =>
            connected(profile, fingerprint, path, dialog.destination)
          }
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
          t={t}
          onClose={closeDialog}
        />
      )}
      <Tooltips />
    </div>
  );
}
function ServerIcon() {
  return <Cloud size={16} />;
}
function LockIcon() {
  return (
    <span className="local-lock">
      <Wifi size={11} />
    </span>
  );
}
