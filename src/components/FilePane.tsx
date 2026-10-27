import {
  useEffect,
  useMemo,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  ChevronDown,
  FolderOpen,
  Plus,
  RefreshCw,
  Search,
  Star,
  X,
  LockKeyhole,
  Cloud,
  Check,
  LoaderCircle,
  Scissors,
} from "lucide-react";
import * as api from "../api";
import {
  basename,
  extension,
  parent as parentPath,
  size,
  sortEntries,
} from "../utils";
import { FileIcon, IconButton } from "./Primitives";
import type {
  Entry,
  Location,
  PaneState,
  Settings,
  SftpProfile,
  FileClipboard,
} from "../types";
import type { Text } from "../i18n";
import { formatRemoteAddress } from "../address";
import { matchesMask } from "../selection";
import { Modal } from "./Primitives";
import { clipboardPathKey } from "../clipboard";

export type PaneSnapshot = {
  entries: Entry[];
  selected: Entry[];
  focused?: Entry;
};
export type PaneHandle = {
  path: () => void;
  filter: () => void;
  refresh: () => void;
  up: () => void;
  all: () => void;
  clear: () => void;
  invert: () => void;
  pattern: (remove?: boolean) => void;
  reveal: (folder: Location, path: string) => void;
};
type Props = {
  controls: Ref<PaneHandle>;
  index: number;
  state: PaneState;
  active: boolean;
  settings: Settings;
  profiles: SftpProfile[];
  t: Text;
  refresh: number;
  clipboard: FileClipboard | null;
  bookmarked: boolean;
  onCancelCut: () => void;
  activate: () => void;
  navigate: (location: Location) => void;
  history: (delta: number) => void;
  newTab: () => void;
  closeTab: (id: string) => void;
  selectTab: (id: string) => void;
  onSelection: (snapshot: PaneSnapshot) => void;
  onOpen: (entry: Entry) => void;
  onBookmark: () => void;
  onContext: (
    entries: Entry[],
    location: Location,
    position: { x: number; y: number },
  ) => void;
  onError: (error: string) => void;
  onDrop: (
    location: Location,
    paths: string[],
    source: string,
    move: boolean,
  ) => void;
};
export function FilePane(p: Props) {
  const { t, state, settings } = p;
  const tab = state.tabs.find((x) => x.id === state.activeTab) || state.tabs[0];
  const { location } = tab;
  const remoteProfile = p.profiles.find(
    (p) => `sftp:${p.id}` === location.source,
  );
  const displayPath = remoteProfile
    ? formatRemoteAddress(remoteProfile, location.path)
    : location.path;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string>();
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [settled, setSettled] = useState("");
  const [error, setError] = useState("");
  const [sort, setSort] = useState<"name" | "size" | "modified" | "type">(
    "name",
  );
  const [desc, setDesc] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  const [pathValue, setPathValue] = useState(location.path);
  const [localRefresh, setLocalRefresh] = useState(0);
  const [dropOver, setDropOver] = useState(false);
  const [pattern, setPattern] = useState<{
    remove: boolean;
    mask: string;
    folders: boolean;
  }>();
  const pathInput = useRef<HTMLInputElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const anchor = useRef(0);
  const drag = useRef<{
    x: number;
    y: number;
    paths: string[];
    dragging: boolean;
  } | null>(null);
  const dragged = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const loadedLocation = useRef("");
  const reveal = useRef<{ folder: Location; path: string } | undefined>(
    undefined,
  );
  useEffect(() => {
    // Tab changes return navigation to the list; merely clicking another pane's input must keep that input focused.
    if (p.active && !document.querySelector('[role="dialog"]'))
      root.current?.querySelector<HTMLElement>(".file-grid")?.focus();
  }, [state.activeTab]);
  const dataEntries = useMemo(
    () =>
      sortEntries(
        entries.filter(
          (e) =>
            (settings.showHidden || !e.hidden) &&
            e.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
        ),
        sort,
        desc,
      ),
    [entries, settings.showHidden, filter, sort, desc],
  );
  const visible = useMemo(() => {
    const hasParent =
      parentPath(location.path) !== location.path ||
      (location.source.startsWith("zip:") && location.path === "/");
    const up: Entry = {
      name: "..",
      path: `__parent__:${location.source}:${location.path}`,
      isDir: true,
      isSymlink: false,
      size: 0,
      modified: 0,
      hidden: false,
      isParent: true,
    };
    return hasParent ? [up, ...dataEntries] : dataEntries;
  }, [dataEntries, location.source, location.path]);
  const selectedEntries = useMemo(
    () => visible.filter((e) => !e.isParent && selected.has(e.path)),
    [visible, selected],
  );
  const cutPaths = useMemo(
    () =>
      new Set(
        p.clipboard?.cut && p.clipboard.source === location.source
          ? p.clipboard.paths.map(clipboardPathKey)
          : [],
      ),
    [p.clipboard, location.source],
  );
  function editPath() {
    setPathValue(displayPath);
    setEditingPath(true);
    requestAnimationFrame(() => {
      pathInput.current?.focus();
      pathInput.current?.select();
    });
  }
  function invertSelection() {
    setSelected(
      (old) =>
        new Set(dataEntries.filter((e) => !old.has(e.path)).map((e) => e.path)),
    );
  }
  useImperativeHandle(p.controls, () => ({
    reveal: (folder, path) => {
      reveal.current = { folder, path };
      setFilter("");
      setLocalRefresh((n) => n + 1);
    },
    path: editPath,
    filter: () => {
      filterInput.current?.focus();
      filterInput.current?.select();
    },
    refresh: () => setLocalRefresh((n) => n + 1),
    up: goUp,
    all: () => setSelected(new Set(dataEntries.map((e) => e.path))),
    clear: () => setSelected(new Set()),
    invert: invertSelection,
    pattern: (remove = false) =>
      setPattern({ remove, mask: "*", folders: true }),
  }));
  const rowHeight = settings.density === "compact" ? 32 : 40;
  const virtual = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    getItemKey: (i) => visible[i].path,
  });
  useEffect(() => {
    virtual.measure();
  }, [rowHeight]);
  useEffect(() => {
    const id = ++generation.current;
    const key = `${state.activeTab}\0${location.source}\0${location.path}`;
    const changed = loadedLocation.current !== key;
    loadedLocation.current = key;
    if (changed) {
      setEntries([]);
      setSelected(new Set());
      setFocused(undefined);
      setFilter("");
      setPathValue(location.path);
      setEditingPath(false);
    }
    setLoading(true);
    setError("");
    const pending: Entry[] = [];
    let flush: ReturnType<typeof setTimeout> | undefined;
    api
      .list(location, (batch) => {
        if (id !== generation.current) return;
        pending.push(...batch.entries);
        if (batch.done) {
          clearTimeout(flush);
          setEntries([...pending]);
          if (!changed) {
            const paths = new Set(pending.map((e) => e.path));
            setSelected(
              (old) => new Set([...old].filter((path) => paths.has(path))),
            );
            setFocused((old) =>
              old && (paths.has(old) || old.startsWith("__parent__:"))
                ? old
                : undefined,
            );
          }
        } else if (changed && !flush)
          flush = setTimeout(() => {
            flush = undefined;
            if (id === generation.current) setEntries([...pending]);
          }, 40);
        if (batch.error) setError(batch.error);
        if (batch.done) {
          setSettled(key);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (id === generation.current) {
          setError(String(e));
          setLoading(false);
        }
      });
    return () => {
      generation.current++;
      clearTimeout(flush);
    };
  }, [
    location.source,
    location.path,
    state.activeTab,
    p.refresh,
    localRefresh,
  ]);
  useEffect(() => {
    p.onSelection({
      entries: visible,
      selected: selectedEntries,
      focused: visible.find((e) => !e.isParent && e.path === focused),
    });
  }, [visible, selectedEntries, focused]);
  useEffect(() => {
    const request = reveal.current;
    if (
      !request ||
      loading ||
      settled !== `${state.activeTab}\0${location.source}\0${location.path}` ||
      request.folder.source !== location.source ||
      request.folder.path !== location.path
    )
      return;
    const index = visible.findIndex((entry) => entry.path === request.path);
    reveal.current = undefined;
    if (index < 0) return;
    setFocused(request.path);
    setSelected(new Set([request.path]));
    requestAnimationFrame(() => {
      virtual.scrollToIndex(index, { align: "auto" });
      root.current?.querySelector<HTMLElement>(".file-grid")?.focus();
    });
  }, [visible, loading, settled, location.source, location.path]);
  useEffect(() => {
    const node = root.current;
    const receive = (event: Event) => {
      const { paths, source, move } = (
        event as CustomEvent<{ paths: string[]; source: string; move: boolean }>
      ).detail;
      p.onDrop(location, paths, source, move);
    };
    node?.addEventListener("commander-drop", receive);
    return () => node?.removeEventListener("commander-drop", receive);
  }, [location.source, location.path, p.onDrop]);
  useEffect(() => {
    if (!api.desktop) return;
    const id = `pane-${p.index}`;
    let refreshTimer: ReturnType<typeof setTimeout>;
    const subscription = api.subscribe<string>(
      "directory-changed",
      (changed) => {
        if (changed === id) {
          clearTimeout(refreshTimer);
          refreshTimer = setTimeout(() => setLocalRefresh((n) => n + 1), 250);
        }
      },
    );
    api
      .command("watch_directory", {
        id,
        path:
          location.source === "local" && !/^\\\\[^\\]+\\?$/.test(location.path)
            ? location.path
            : null,
      })
      .catch((e) => p.onError(String(e)));
    return () => {
      clearTimeout(refreshTimer);
      subscription.then((unlisten) => unlisten());
      api.command("watch_directory", { id, path: null }).catch(() => {});
    };
  }, [location.source, location.path, p.index]);
  function choose(
    entry: Entry,
    index: number,
    e: Pick<MouseEvent, "shiftKey" | "ctrlKey" | "metaKey">,
  ) {
    p.activate();
    setFocused(entry.path);
    if (entry.isParent && !e.shiftKey) {
      if (!e.ctrlKey && !e.metaKey) setSelected(new Set());
      return;
    }
    setSelected((current) => {
      if (e.shiftKey)
        return new Set(
          visible
            .slice(
              Math.min(anchor.current, index),
              Math.max(anchor.current, index) + 1,
            )
            .filter((e) => !e.isParent)
            .map((e) => e.path),
        );
      anchor.current = index;
      if (e.ctrlKey || e.metaKey) {
        const next = new Set(current);
        next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path);
        return next;
      }
      return new Set([entry.path]);
    });
  }
  function keyDown(e: KeyboardEvent) {
    if ((e.target as HTMLElement).matches("input, button")) return;
    let index = visible.findIndex((x) => x.path === focused);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelected(
        e.shiftKey ? new Set() : new Set(dataEntries.map((e) => e.path)),
      );
      return;
    }
    if (
      ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "i") ||
      (!e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        (e.key === "*" || e.code === "NumpadMultiply"))
    ) {
      e.preventDefault();
      invertSelection();
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && ["+", "-"].includes(e.key)) {
      e.preventDefault();
      setPattern({ remove: e.key === "-", mask: "*", folders: true });
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (filter) setFilter("");
      else {
        setSelected(new Set());
        p.onCancelCut();
      }
      return;
    }
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      const entry = visible.find(
        (item) => item.path === focused && !item.isParent,
      );
      const bounds = root.current!.getBoundingClientRect();
      if (entry && !selected.has(entry.path))
        setSelected(new Set([entry.path]));
      p.onContext(
        entry ? (selected.has(entry.path) ? selectedEntries : [entry]) : [],
        location,
        { x: bounds.left + 70, y: bounds.top + 150 },
      );
      return;
    }
    if (
      !e.altKey &&
      (!(e.ctrlKey || e.metaKey) || !["PageUp", "PageDown"].includes(e.key)) &&
      ["ArrowDown", "ArrowUp", "Home", "End", "PageUp", "PageDown"].includes(
        e.key,
      )
    ) {
      e.preventDefault();
      const page = Math.max(
        1,
        Math.floor(
          (scroller.current?.clientHeight || rowHeight * 10) / rowHeight,
        ) - 1,
      );
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? visible.length - 1
            : Math.max(
                0,
                Math.min(
                  visible.length - 1,
                  Math.max(0, index) +
                    (e.key === "PageDown"
                      ? page
                      : e.key === "PageUp"
                        ? -page
                        : e.key === "ArrowDown"
                          ? 1
                          : -1),
                ),
              );
      if (visible[next]) {
        if (e.shiftKey)
          choose(visible[next], next, {
            shiftKey: true,
            ctrlKey: false,
            metaKey: false,
          });
        else {
          setFocused(visible[next].path);
          anchor.current = next;
        }
        virtual.scrollToIndex(next, {
          align:
            e.key === "Home" || e.key === "PageUp"
              ? "start"
              : e.key === "End" || e.key === "PageDown"
                ? "end"
                : "auto",
        });
      }
      return;
    }
    if (
      ((e.key === "Insert" && !e.shiftKey) || e.key === " ") &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      e.preventDefault();
      if (index < 0) index = 0;
      if (visible[index]) {
        const entry = visible[index];
        if (!entry.isParent)
          setSelected((current) => {
            const next = new Set(current);
            next.has(entry.path)
              ? next.delete(entry.path)
              : next.add(entry.path);
            return next;
          });
        const nextIndex =
          e.key === "Insert" ? Math.min(index + 1, visible.length - 1) : index;
        setFocused(visible[nextIndex].path);
        anchor.current = nextIndex;
        virtual.scrollToIndex(nextIndex);
      }
      return;
    }
    if (e.key === "Enter" && focused && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const entry = visible.find((x) => x.path === focused);
      if (entry?.isParent) goUp();
      else if (entry) p.onOpen(entry);
    }
    if (e.key === "Backspace") {
      e.preventDefault();
      goUp();
    }
    if (e.altKey && e.key === "ArrowLeft") {
      e.preventDefault();
      p.history(-1);
    }
    if (e.altKey && e.key === "ArrowRight") {
      e.preventDefault();
      p.history(1);
    }
  }
  const bookmarked = p.bookmarked;
  const sourceLabel = location.source.startsWith("zip:")
    ? t.readOnly
    : location.source.startsWith("sftp:")
      ? remoteProfile
        ? `${remoteProfile.username}@${remoteProfile.host}`
        : "SFTP"
      : t.local;
  function sortBy(key: typeof sort) {
    sort === key ? setDesc(!desc) : (setSort(key), setDesc(false));
  }
  function goUp() {
    p.navigate(
      location.source.startsWith("zip:") && location.path === "/"
        ? { source: "local", path: parentPath(location.source.slice(4)) }
        : { ...location, path: parentPath(location.path) },
    );
  }
  return (
    <section
      ref={root}
      className={`file-pane ${p.active ? "active" : ""} ${dropOver ? "drop-over" : ""}`}
      onFocus={p.activate}
      onMouseDown={p.activate}
      data-pane={p.index}
      onPointerMove={(e) => {
        if (
          drag.current &&
          e.buttons === 1 &&
          Math.hypot(e.clientX - drag.current.x, e.clientY - drag.current.y) > 7
        ) {
          drag.current.dragging = true;
          dragged.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          document.body.style.cursor = e.shiftKey ? "move" : "copy";
        }
      }}
      onPointerCancel={() => {
        drag.current = null;
        document.body.style.cursor = "";
      }}
      onPointerUp={(e) => {
        const item = drag.current;
        drag.current = null;
        document.body.style.cursor = "";
        if (!item?.dragging) return;
        const destination = document
          .elementFromPoint(e.clientX, e.clientY)
          ?.closest<HTMLElement>("[data-pane]");
        if (destination && Number(destination.dataset.pane) !== p.index)
          destination.dispatchEvent(
            new CustomEvent("commander-drop", {
              detail: {
                paths: item.paths,
                source: location.source,
                move: e.shiftKey,
              },
            }),
          );
        setTimeout(() => {
          dragged.current = false;
        }, 0);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-supercommander")) {
          e.preventDefault();
          setDropOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node))
          setDropOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropOver(false);
        try {
          const data = JSON.parse(
            e.dataTransfer.getData("application/x-supercommander"),
          );
          p.onDrop(location, data.paths, data.source, e.shiftKey);
        } catch {
          /* Native files are handled by Tauri's drag/drop event. */
        }
      }}
    >
      <div className="pane-tabs">
        <div className="tabs-scroll">
          {state.tabs.map((item) => (
            <div
              key={item.id}
              className={`pane-tab ${item.id === state.activeTab ? "selected" : ""}`}
            >
              <button onClick={() => p.selectTab(item.id)}>
                <FolderOpen size={14} />
                <span>{basename(item.location.path)}</span>
              </button>
              {state.tabs.length > 1 && (
                <button
                  className="tab-close"
                  aria-label={t.closeTab}
                  onClick={() => p.closeTab(item.id)}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
        <IconButton title={t.newTab} shortcut="Ctrl+T" onClick={p.newTab}>
          <Plus size={15} />
        </IconButton>
        <span className="pane-indicator">{p.index === 0 ? "01" : "02"}</span>
      </div>
      <div className="path-toolbar">
        <div className="navigation-buttons">
          <IconButton
            title={t.back}
            shortcut="Alt+Left"
            disabled={tab.historyIndex <= 0}
            onClick={() => p.history(-1)}
          >
            <ArrowLeft size={15} />
          </IconButton>
          <IconButton
            title={t.forward}
            shortcut="Alt+Right"
            disabled={tab.historyIndex >= tab.history.length - 1}
            onClick={() => p.history(1)}
          >
            <ArrowRight size={15} />
          </IconButton>
          <IconButton title={t.up} shortcut="Alt+Up / Backspace" onClick={goUp}>
            <ArrowUp size={15} />
          </IconButton>
        </div>
        {editingPath ? (
          <form
            className="path-form"
            onSubmit={(e) => {
              e.preventDefault();
              p.navigate({ ...location, path: pathValue });
            }}
          >
            <input
              ref={pathInput}
              autoFocus
              aria-label={t.destination}
              placeholder={t.remoteAddressHint}
              value={pathValue}
              onChange={(e) => setPathValue(e.target.value)}
              onBlur={() => setEditingPath(false)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setEditingPath(false);
                  root.current
                    ?.querySelector<HTMLElement>(".file-grid")
                    ?.focus();
                }
              }}
            />
          </form>
        ) : (
          <button
            className="breadcrumbs"
            title={displayPath}
            data-shortcut="Ctrl+L / Alt+D"
            onClick={editPath}
          >
            <span>
              {location.path
                .split(/[\\/]/)
                .filter(Boolean)
                .slice(-3)
                .map((part, i) => (
                  <span key={i}>
                    {i > 0 && <ChevronRight size={12} />}
                    <span>{part}</span>
                  </span>
                ))}
            </span>
          </button>
        )}
        <IconButton
          title={bookmarked ? t.removeFavorite : t.addFavorite}
          shortcut="Ctrl+D"
          className={bookmarked ? "is-bookmarked" : ""}
          onClick={p.onBookmark}
        >
          <Star size={15} fill={bookmarked ? "currentColor" : "none"} />
        </IconButton>
        <IconButton
          title={t.refresh}
          shortcut="Ctrl+R"
          onClick={() => setLocalRefresh((n) => n + 1)}
        >
          <RefreshCw size={14} className={loading ? "spin" : ""} />
        </IconButton>
      </div>
      <div className="pane-context">
        <span>
          {location.source.startsWith("sftp:") ? (
            <Cloud size={12} />
          ) : location.source.startsWith("zip:") ? (
            <LockKeyhole size={12} />
          ) : (
            <FolderOpen size={12} />
          )}{" "}
          {sourceLabel}
        </span>
        <label className="folder-filter">
          <Search size={12} />
          <input
            ref={filterInput}
            data-shortcut="Ctrl+Shift+F"
            aria-label={t.filter}
            placeholder={t.filter}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setFilter("");
                root.current?.querySelector<HTMLElement>(".file-grid")?.focus();
              } else if (e.key === "Enter" || e.key === "ArrowDown") {
                e.preventDefault();
                e.stopPropagation();
                const first = visible.findIndex((entry) => !entry.isParent);
                if (first >= 0) {
                  setFocused(visible[first].path);
                  anchor.current = first;
                  virtual.scrollToIndex(first);
                }
                root.current?.querySelector<HTMLElement>(".file-grid")?.focus();
              }
            }}
          />
          {filter && (
            <button aria-label={t.close} onClick={() => setFilter("")}>
              <X size={11} />
            </button>
          )}
        </label>
      </div>
      <div
        className="file-grid"
        role="grid"
        aria-label={`${t.workspace} ${p.index + 1}`}
        aria-rowcount={visible.length + 1}
        aria-activedescendant={
          focused
            ? `pane-${p.index}-row-${visible.findIndex((e) => e.path === focused)}`
            : undefined
        }
        tabIndex={0}
        onKeyDown={keyDown}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          p.activate();
          e.currentTarget.focus();
          p.onContext([], location, { x: e.clientX, y: e.clientY });
        }}
      >
        <div className="list-columns" role="row">
          <span />
          <button role="columnheader" onClick={() => sortBy("name")}>
            {t.name}
            {sort === "name" && (
              <ChevronDown size={11} className={desc ? "rotate" : ""} />
            )}
          </button>
          <button role="columnheader" onClick={() => sortBy("size")}>
            {t.size}
            {sort === "size" && <ChevronDown size={11} />}
          </button>
          <button
            className="type-column"
            role="columnheader"
            onClick={() => sortBy("type")}
          >
            {t.type}
            {sort === "type" && <ChevronDown size={11} />}
          </button>
          <button role="columnheader" onClick={() => sortBy("modified")}>
            {t.modified}
            {sort === "modified" && <ChevronDown size={11} />}
          </button>
        </div>
        <div className="file-scroll" ref={scroller}>
          {error && (
            <div className="pane-error">
              <span>{t.viewError}</span>
              <small>{error}</small>
              <button onClick={() => setLocalRefresh((n) => n + 1)}>
                {t.retry}
              </button>
            </div>
          )}
          <div
            style={{
              height: virtual.getTotalSize(),
              position: "relative",
              width: "100%",
            }}
          >
            {virtual.getVirtualItems().map((row) => {
              const entry = visible[row.index];
              const isSelected = selected.has(entry.path);
              const isCut = cutPaths.has(clipboardPathKey(entry.path));
              return (
                <div
                  key={entry.path}
                  className={`file-row ${entry.isParent ? "parent-entry" : ""} ${isCut ? "cut-entry" : ""} ${isSelected ? "selected" : ""} ${entry.hidden ? "hidden-entry" : ""} ${focused === entry.path ? "focused" : ""}`}
                  role="row"
                  id={`pane-${p.index}-row-${row.index}`}
                  aria-rowindex={row.index + 2}
                  aria-selected={isSelected}
                  style={{
                    height: rowHeight,
                    transform: `translateY(${row.start}px)`,
                  }}
                  onClick={(e) => {
                    if (!dragged.current) choose(entry, row.index, e);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    p.activate();
                    root.current
                      ?.querySelector<HTMLElement>(".file-grid")
                      ?.focus();
                    setFocused(entry.path);
                    const chosen = entry.isParent
                      ? []
                      : selected.has(entry.path)
                        ? selectedEntries
                        : [entry];
                    if (!entry.isParent && !selected.has(entry.path))
                      setSelected(new Set([entry.path]));
                    p.onContext(chosen, location, {
                      x: e.clientX,
                      y: e.clientY,
                    });
                  }}
                  onDoubleClick={() =>
                    entry.isParent ? goUp() : p.onOpen(entry)
                  }
                  onPointerDown={(e) => {
                    if (e.button === 0 && !entry.isParent)
                      drag.current = {
                        x: e.clientX,
                        y: e.clientY,
                        paths: selected.has(entry.path)
                          ? selectedEntries.map((e) => e.path)
                          : [entry.path],
                        dragging: false,
                      };
                  }}
                >
                  <span
                    className={`file-check ${isSelected ? "checked" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      choose(entry, row.index, {
                        shiftKey: false,
                        ctrlKey: true,
                        metaKey: false,
                      });
                    }}
                  >
                    {isSelected && <Check size={10} />}
                  </span>
                  <span className="file-name" role="gridcell">
                    <FileIcon entry={entry} />
                    {isCut && (
                      <Scissors
                        size={11}
                        className="cut-indicator"
                        aria-label={t.cutPending}
                      />
                    )}
                    <span>{entry.name}</span>
                  </span>
                  <span className="file-size" role="gridcell">
                    {entry.isDir ? "—" : size(entry.size)}
                  </span>
                  <span className="file-type type-column" role="gridcell">
                    {entry.isDir
                      ? "—"
                      : extension(entry).toUpperCase() || t.file}
                  </span>
                  <span className="file-date" role="gridcell">
                    {entry.modified
                      ? new Date(entry.modified * 1000).toLocaleDateString(
                          settings.language === "et" ? "et-EE" : "en-GB",
                          { day: "2-digit", month: "short", year: "numeric" },
                        )
                      : "—"}
                  </span>
                </div>
              );
            })}
          </div>
          {!error && dataEntries.length === 0 && (
            <div className="empty-state">
              {loading ? (
                <LoaderCircle className="spin" size={28} />
              ) : (
                <FolderOpen size={34} strokeWidth={1} />
              )}
              <h3>{loading ? t.loading : filter ? t.noResults : t.empty}</h3>
              {!loading && !filter && <p>{t.emptyHint}</p>}
            </div>
          )}
        </div>
      </div>
      <footer className="pane-footer">
        <span>
          <span className="subtle-dot" />
          {dataEntries.length.toLocaleString()} {t.items}
          {selectedEntries.length > 0 && (
            <>
              <span className="footer-divider">/</span>
              <strong>
                {selectedEntries.length} {t.selected}
              </strong>
            </>
          )}
        </span>
        <span>
          {size(
            selectedEntries.length
              ? selectedEntries.reduce((n, e) => n + (e.isDir ? 0 : e.size), 0)
              : visible.reduce((n, e) => n + (e.isDir ? 0 : e.size), 0),
          )}
        </span>
      </footer>
      {pattern && (
        <Modal
          closeLabel={t.close}
          title={pattern.remove ? t.deselectPattern : t.selectPattern}
          subtitle={t.patternHint}
          onClose={() => setPattern(undefined)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const matched = dataEntries.filter(
                (entry) =>
                  (pattern.folders || !entry.isDir) &&
                  matchesMask(entry.name, pattern.mask),
              );
              setSelected((old) => {
                const next = new Set(old);
                for (const entry of matched) {
                  if (pattern.remove) next.delete(entry.path);
                  else next.add(entry.path);
                }
                return next;
              });
              setPattern(undefined);
            }}
          >
            <label className="field">
              {t.filePattern}
              <input
                aria-label={t.filePattern}
                autoFocus
                value={pattern.mask}
                required
                onChange={(e) =>
                  setPattern({ ...pattern, mask: e.target.value })
                }
              />
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={pattern.folders}
                onChange={(e) =>
                  setPattern({ ...pattern, folders: e.target.checked })
                }
              />
              {t.includeFolders}
            </label>
            <footer className="modal-actions">
              <button type="button" onClick={() => setPattern(undefined)}>
                {t.cancel}
              </button>
              <button type="submit" className="primary">
                {t.apply}
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </section>
  );
}
