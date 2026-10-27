import { useEffect, useState } from "react";
import {
  ArrowLeftRight,
  ListFilter,
  MoreHorizontal,
  Settings2,
  TerminalSquare,
} from "lucide-react";
import { IconButton } from "./Primitives";
import type { PaletteAction } from "./Dialogs";
import type { Text } from "../i18n";

export function WorkspaceTools({
  t,
  hidden,
  terminal,
  onSwap,
  onHidden,
  onTerminal,
  onSettings,
  actions,
}: {
  t: Text;
  hidden: boolean;
  terminal: boolean;
  onSwap: () => void;
  onHidden: () => void;
  onTerminal: () => void;
  onSettings: () => void;
  actions: PaletteAction[];
}) {
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
      if (
        event.key === "F9" &&
        !document.querySelector('[role="dialog"]') &&
        !(event.target as HTMLElement).closest(
          "input,textarea,select,.terminal-panel",
        )
      ) {
        event.preventDefault();
        setMenu((v) => !v);
      }
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, []);
  return (
    <div className="toolbar-right titlebar-tools">
      <IconButton title={t.swap} shortcut="Ctrl+U" onClick={onSwap}>
        <ArrowLeftRight size={16} />
      </IconButton>
      <IconButton
        title={t.hidden}
        shortcut="Ctrl+H"
        className={hidden ? "pressed" : ""}
        onClick={onHidden}
      >
        <ListFilter size={16} />
      </IconButton>
      <span className="toolbar-separator" />
      <IconButton
        title={t.terminal}
        shortcut="Ctrl+`"
        className={terminal ? "pressed" : ""}
        onClick={onTerminal}
      >
        <TerminalSquare size={16} />
      </IconButton>
      <div className="menu-anchor">
        <button
          className={`icon-button ${menu ? "pressed" : ""}`}
          aria-label={t.actions}
          title={t.actions}
          data-shortcut="F9"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu((v) => !v)}
        >
          <MoreHorizontal size={18} />
        </button>
        {menu && (
          <>
            <div className="menu-dismiss" onClick={() => setMenu(false)} />
            <div
              className="dropdown-menu glass"
              role="menu"
              aria-label={t.actions}
            >
              {actions
                .filter((a) =>
                  [
                    "search",
                    "zip",
                    "extract",
                    "connect",
                    "disconnect",
                    "sshConfig",
                    "forward",
                  ].includes(a.id),
                )
                .map((a) => (
                  <button
                    key={a.id}
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      a.run();
                    }}
                  >
                    {a.icon}
                    <span>{a.label}</span>
                    {a.key && <kbd>{a.key}</kbd>}
                  </button>
                ))}
            </div>
          </>
        )}
      </div>
      <IconButton title={t.settings} shortcut="Ctrl+," onClick={onSettings}>
        <Settings2 size={16} />
      </IconButton>
    </div>
  );
}
