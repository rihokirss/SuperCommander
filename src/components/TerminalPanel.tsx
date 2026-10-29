import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TerminalSquare, X, Plus, Maximize2, Minimize2 } from "lucide-react";
import { command, desktop } from "../api";
import { IconButton } from "./Primitives";
import { TerminalSync, type TerminalSyncStatus } from "../terminalSync";
import type { Text } from "../i18n";
import "@xterm/xterm/css/xterm.css";
export type TerminalTab = {
  id: string;
  source: string;
  path: string;
  label: string;
};
export function TerminalPanel({
  path,
  source,
  label,
  syncPath,
  tabs,
  activeTab,
  onSelectTab,
  onNewTab,
  onCloseTab,
  t,
  onClose,
  theme,
  palette,
  hidden,
  fullscreen,
  height,
  onResize,
  onToggleFullscreen,
}: {
  path: string;
  source: string;
  label: string;
  syncPath: string | null;
  tabs: TerminalTab[];
  activeTab: string;
  onSelectTab: (id: string) => void;
  onNewTab: () => void;
  onCloseTab: (id: string) => void;
  t: Text;
  onClose: () => void;
  theme: "dark" | "light";
  palette: string;
  hidden: boolean;
  fullscreen: boolean;
  height: number;
  onResize: (height: number) => void;
  onToggleFullscreen: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const resizeStart = useRef<{ y: number; height: number } | null>(null);
  const [error, setError] = useState("");
  const [syncStatus, setSyncStatus] = useState<TerminalSyncStatus>("waiting");
  const instance = useRef<Terminal | null>(null);
  const sync = useRef<TerminalSync | null>(null);
  const target = useRef(syncPath);
  target.current = syncPath;
  const visible = useRef(!hidden);
  visible.current = !hidden;
  function resize(height: number) {
    const section = panel.current;
    const pane =
      section?.parentElement?.querySelector<HTMLElement>(".pane-layout");
    if (!section || !pane) return;
    const max = Math.max(
      120,
      section.offsetHeight + Math.max(0, pane.offsetHeight - 180),
    );
    onResize(Math.round(Math.max(120, Math.min(max, height))));
  }
  const terminalTheme = (light: boolean) => ({
    background: "#00000000",
    foreground: light ? "#18354d" : "#d8ebfa",
    cursor: light ? "#287db8" : "#a6dcff",
    selectionBackground: light
      ? "#acd9f7"
      : palette.toLowerCase().includes("red")
        ? "#f1a3ad"
        : "#80caff",
    selectionForeground:
      !light && palette.toLowerCase().includes("red") ? "#35151b" : "#102b42",
    selectionInactiveBackground: light
      ? "#c5e5fc"
      : palette.toLowerCase().includes("red")
        ? "#b8757c"
        : "#6398bd",
  });
  useEffect(() => {
    if (instance.current)
      instance.current.options.theme = terminalTheme(theme === "light");
  }, [theme, palette]);
  useEffect(() => {
    if (!element.current || !desktop) return;
    let id: string | undefined;
    let disposed = false;
    let pendingInput = "";
    let writeQueue = Promise.resolve();
    const marker = crypto.randomUUID().replaceAll("-", "");
    function send(data: string) {
      if (!id) {
        pendingInput += data;
        return;
      }
      const session = id;
      writeQueue = writeQueue
        .then(() => command("terminal_write", { source, id: session, data }))
        .then(() => {})
        .catch((e) => {
          if (!disposed) setError(String(e));
        });
    }
    const term = new Terminal({
      fontFamily: "Cascadia Code, Consolas, monospace",
      fontSize: 12,
      cursorBlink: true,
      allowTransparency: true,
      theme: terminalTheme(theme === "light"),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    instance.current = term;
    const follow = new TerminalSync(source === "local", send, setSyncStatus);
    sync.current = follow;
    follow.setTarget(target.current);
    let seenPrompt = false;
    const promptMarker = term.parser.registerOscHandler(633, (data) => {
      const prefix = `SC:${marker}:`;
      if (!data.startsWith(prefix)) return false;
      try {
        const bytes = Uint8Array.from(atob(data.slice(prefix.length)), (value) =>
          value.charCodeAt(0),
        );
        const cwd = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        seenPrompt = true;
        follow.prompt(cwd);
      } catch {
        /* Ignore malformed shell markers. */
      }
      return true;
    });
    const markerTimeout = window.setTimeout(() => {
      if (!disposed && !seenPrompt) follow.unsupported();
    }, 12000);
    term.attachCustomKeyEventHandler(
      (event) =>
        !(
          event.ctrlKey &&
          (event.key.toLowerCase() === "o" ||
            event.key === "`" ||
            event.code === "Backquote")
        ),
    );
    term.loadAddon(fit);
    term.open(element.current);
    fit.fit();
    const channel = new Channel<number[]>();
    channel.onmessage = (data) => {
      if (!disposed) term.write(Uint8Array.from(data));
    };
    command<string>("terminal_open", { source, path, channel, marker })
      .then((session) => {
        if (disposed) {
          command("terminal_close", { source, id: session }).catch(() => {});
          return;
        }
        id = session;
        command("terminal_resize", {
          source,
          id,
          rows: term.rows,
          cols: term.cols,
        }).catch((e) => setError(String(e)));
        if (pendingInput) {
          send(pendingInput);
          pendingInput = "";
        }
        if (visible.current) term.focus();
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    const keyInput = term.onKey(({ key }) => follow.input(key));
    // xterm's onData also contains terminal protocol replies, which are not
    // typed commands. Track keyboard, paste and composition separately.
    const mount = element.current;
    const markPaste = (event: ClipboardEvent) =>
      follow.input(event.clipboardData?.getData("text/plain") || "input");
    const markComposition = () => follow.input("input");
    mount.addEventListener("paste", markPaste, true);
    mount.addEventListener("compositionstart", markComposition, true);
    const input = term.onData((data) => {
      send(data);
    });
    const observer = new ResizeObserver(() => {
      if (!element.current?.offsetHeight) return;
      fit.fit();
      if (id)
        command("terminal_resize", {
          source,
          id,
          rows: term.rows,
          cols: term.cols,
        }).catch(() => {});
    });
    observer.observe(element.current);
    return () => {
      disposed = true;
      window.clearTimeout(markerTimeout);
      promptMarker.dispose();
      observer.disconnect();
      mount.removeEventListener("paste", markPaste, true);
      mount.removeEventListener("compositionstart", markComposition, true);
      keyInput.dispose();
      input.dispose();
      term.dispose();
      instance.current = null;
      sync.current = null;
      if (id) command("terminal_close", { source, id }).catch(() => {});
    };
  }, [path, source]);
  useEffect(() => {
    sync.current?.setTarget(syncPath);
  }, [syncPath]);
  useEffect(() => {
    if (!hidden) requestAnimationFrame(() => instance.current?.focus());
  }, [hidden, fullscreen]);
  return (
    <section
      ref={panel}
      className={`terminal-panel glass ${fullscreen ? "terminal-fullscreen" : ""}`}
      style={
        fullscreen
          ? undefined
          : { height: Math.max(120, Number.isFinite(height) ? height : 242) }
      }
      hidden={hidden}
      data-terminal-source={source}
      data-terminal-id={activeTab}
    >
      {!fullscreen && (
        <div
          className="terminal-resize"
          role="separator"
          aria-label={t.resizeTerminal}
          data-tooltip={t.resizeTerminal}
          aria-orientation="horizontal"
          aria-valuemin={120}
          aria-valuemax={window.innerHeight}
          aria-valuenow={Math.round(height)}
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0 || !panel.current) return;
            resizeStart.current = {
              y: event.clientY,
              height: panel.current.offsetHeight,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            if (
              resizeStart.current &&
              event.currentTarget.hasPointerCapture(event.pointerId)
            )
              resize(
                resizeStart.current.height +
                  resizeStart.current.y -
                  event.clientY,
              );
          }}
          onPointerUp={() => {
            resizeStart.current = null;
          }}
          onPointerCancel={() => {
            resizeStart.current = null;
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            resize(
              (panel.current?.offsetHeight ?? height) +
                (event.key === "ArrowUp" ? 16 : -16),
            );
          }}
        >
          <span />
        </div>
      )}
      <header>
        <div className="terminal-tabbar">
          <div className="terminal-tabs" role="tablist" aria-label={t.terminalTabs}>
            {tabs.map((tab, index) => (
              <div
                className={`terminal-tab ${activeTab === tab.id ? "active" : ""}`}
                key={tab.id}
              >
                <button
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  tabIndex={activeTab === tab.id ? 0 : -1}
                  data-terminal-tab-id={tab.id}
                  data-tooltip={tab.label}
                  onClick={() => onSelectTab(tab.id)}
                  onKeyDown={(event) => {
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
                      return;
                    event.preventDefault();
                    const next =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? tabs.length - 1
                          : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
                            tabs.length;
                    const id = tabs[next].id;
                    onSelectTab(id);
                    requestAnimationFrame(() =>
                      requestAnimationFrame(() =>
                        document
                          .querySelector<HTMLElement>(
                            `.terminal-panel:not([hidden]) [data-terminal-tab-id="${id}"]`,
                          )
                          ?.focus(),
                      ),
                    );
                  }}
                >
                  <TerminalSquare size={13} />
                  <span>{tab.source === "local" ? t.local : tab.label}</span>
                  <small>{index + 1}</small>
                </button>
                <IconButton
                  title={`${t.closeTerminalTab}: ${tab.label}`}
                  onClick={() => onCloseTab(tab.id)}
                >
                  <X size={11} />
                </IconButton>
              </div>
            ))}
          </div>
          <IconButton title={t.newTerminalTab} shortcut="Ctrl+Shift+`" onClick={onNewTab}>
            <Plus size={14} />
          </IconButton>
        </div>
        <div className="terminal-controls">
          {desktop && !syncPath && (
            <small className="terminal-sync-status" data-tooltip={t.terminalDifferentSource}>
              {t.terminalDifferentSource}
            </small>
          )}
          {desktop && syncPath && syncStatus !== "synced" && (
            <small
              className="terminal-sync-status"
              data-tooltip={
                syncStatus === "failed"
                  ? t.terminalSyncFailed
                  : syncStatus === "unsupported"
                    ? t.terminalSyncUnsupported
                    : t.terminalSyncWaiting
              }
            >
              {syncStatus === "failed"
                ? t.terminalSyncFailed
                : syncStatus === "unsupported"
                  ? t.terminalSyncUnsupported
                  : t.terminalSyncWaiting}
            </small>
          )}
          <small className="terminal-current-label">{syncPath || label}</small>
          <small>Ctrl+O</small>
          <IconButton
            title={fullscreen ? t.restorePanels : t.fullTerminal}
            onClick={onToggleFullscreen}
          >
            {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </IconButton>
          <IconButton title={t.close} onClick={onClose}>
            <X size={14} />
          </IconButton>
        </div>
      </header>
      {!desktop ? (
        <div className="terminal-notice">
          <p>{t.terminalHint}</p>
          <span>{t.desktopOnly}</span>
        </div>
      ) : (
        <div ref={element} className="terminal-mount" />
      )}
      {error && (
        <div className="inline-error">
          {t.terminalError} {error}
        </div>
      )}
    </section>
  );
}
