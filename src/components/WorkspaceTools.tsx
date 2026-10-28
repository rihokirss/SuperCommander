import { useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight,
  ListFilter,
  MoreHorizontal,
  Moon,
  Settings2,
  Sun,
  TerminalSquare,
} from "lucide-react";
import { IconButton } from "./Primitives";
import type { PaletteAction } from "./Dialogs";
import type { Text } from "../i18n";
import { Menu } from "./Menu";

export function WorkspaceTools({
  t,
  hidden,
  terminal,
  theme,
  onSwap,
  onHidden,
  onTerminal,
  onToggleTheme,
  onSettings,
  actions,
}: {
  t: Text;
  hidden: boolean;
  terminal: boolean;
  theme: "dark" | "light";
  onSwap: () => void;
  onHidden: () => void;
  onTerminal: () => void;
  onToggleTheme: () => void;
  onSettings: () => void;
  actions: PaletteAction[];
}) {
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
      <ActionsMenuButton t={t} actions={actions} keyboard />
      <IconButton
        title={theme === "dark" ? t.switchToLight : t.switchToDark}
        onClick={onToggleTheme}
      >
        {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
      </IconButton>
      <IconButton title={t.settings} shortcut="Ctrl+," onClick={onSettings}>
        <Settings2 size={16} />
      </IconButton>
    </div>
  );
}

export function ActionsMenuButton({
  t,
  actions,
  keyboard = false,
  footer = false,
}: {
  t: Text;
  actions: PaletteAction[];
  keyboard?: boolean;
  footer?: boolean;
}) {
  const [menu, setMenu] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
      if (
        keyboard &&
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
  }, [keyboard]);
  return (
    <div className="menu-anchor">
      <button
        ref={trigger}
        className={`${footer ? "shortcut-action" : "icon-button"} ${menu ? "pressed" : ""}`}
        aria-label={t.actions}
        data-tooltip={t.actions}
        data-shortcut="F9"
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu((v) => !v)}
      >
        {footer ? (
          <>
            <kbd>F9</kbd>
            <span>{t.actions}</span>
          </>
        ) : (
          <MoreHorizontal size={18} />
        )}
      </button>
      {menu && trigger.current && (
        <Menu
          label={t.actions}
          anchor={trigger.current}
          onClose={() => setMenu(false)}
          actions={actions.filter((a) =>
            [
              "search",
              "folderSizes",
              "compare",
              "recovery",
              "zip",
              "extract",
              "connect",
              "disconnect",
              "sshConfig",
              "forward",
              "selectPattern",
              "deselectPattern",
              "invert",
            ].includes(a.id),
          )}
        />
      )}
    </div>
  );
}
