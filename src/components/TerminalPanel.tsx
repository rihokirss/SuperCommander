import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TerminalSquare, X, Maximize2, Minimize2 } from "lucide-react";
import { command, desktop } from "../api";
import { IconButton } from "./Primitives";
import type { Text } from "../i18n";
import "@xterm/xterm/css/xterm.css";
export function TerminalPanel({
  path,
  source,
  label,
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
  const instance = useRef<Terminal | null>(null);
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
    command<string>("terminal_open", { source, path, channel })
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
          command("terminal_write", { source, id, data: pendingInput }).catch(
            (e) => setError(String(e)),
          );
          pendingInput = "";
        }
        term.focus();
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    const input = term.onData((data) => {
      if (id)
        command("terminal_write", { source, id, data }).catch((e) =>
          setError(String(e)),
        );
      else pendingInput += data;
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
      observer.disconnect();
      input.dispose();
      term.dispose();
      instance.current = null;
      if (id) command("terminal_close", { source, id }).catch(() => {});
    };
  }, [path, source]);
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
        <span>
          <TerminalSquare size={14} />
          {t.terminal}
          <small>{label}</small>
        </span>
        <div className="terminal-controls">
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
