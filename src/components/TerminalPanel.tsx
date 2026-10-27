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
  hidden,
  fullscreen,
  onToggleFullscreen,
}: {
  path: string;
  source: string;
  label: string;
  t: Text;
  onClose: () => void;
  theme: "dark" | "light";
  hidden: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const instance = useRef<Terminal | null>(null);
  const terminalTheme = (light: boolean) => ({
    background: "#00000000",
    foreground: light ? "#30435e" : "#bdc7df",
    cursor: light ? "#405eaa" : "#b5c3ff",
    selectionBackground: light ? "#5e76be30" : "#5e76be50",
  });
  useEffect(() => {
    if (instance.current)
      instance.current.options.theme = terminalTheme(theme === "light");
  }, [theme]);
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
          (event.key.toLowerCase() === "o" || event.key === "`")
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
      className={`terminal-panel glass ${fullscreen ? "terminal-fullscreen" : ""}`}
      hidden={hidden}
      data-terminal-source={source}
    >
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
