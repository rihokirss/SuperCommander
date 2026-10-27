import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type MenuAction = {
  id: string;
  label: string;
  icon?: ReactNode;
  key?: string;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  run: () => void;
};

export function Menu({
  label,
  actions,
  anchor,
  theme,
  onClose,
}: {
  label: string;
  actions: MenuAction[];
  anchor: HTMLElement | { x: number; y: number };
  theme?: "dark" | "light";
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const close = useRef(onClose);
  close.current = onClose;
  const items = useRef(actions);
  items.current = actions;
  const restore = useRef(true);
  const search = useRef({ text: "", time: 0 });
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const resolvedTheme =
    theme ||
    (anchor instanceof HTMLElement
      ? anchor.closest<HTMLElement>(".app-shell")?.dataset.theme
      : undefined) ||
    "dark";
  function focus(index: number) {
    setActive(index);
    buttons.current[index]?.focus({ preventScroll: true });
    buttons.current[index]?.scrollIntoView({ block: "nearest" });
  }
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const rect =
      anchor instanceof HTMLElement
        ? anchor.getBoundingClientRect()
        : { left: anchor.x, bottom: anchor.y };
    const bounds = menu.current!.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(rect.left, innerWidth - bounds.width - 8)),
      top: Math.max(
        8,
        Math.min(rect.bottom + 4, innerHeight - bounds.height - 8),
      ),
    });
    const first = items.current.findIndex((a) => !a.disabled);
    if (first >= 0) focus(first);
    else menu.current?.focus();
    const outside = (event: Event) => {
      if (
        menu.current?.contains(event.target as Node) ||
        (anchor instanceof HTMLElement && anchor.contains(event.target as Node))
      )
        return;
      restore.current = false;
      close.current();
    };
    const hide = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) {
        restore.current = false;
        close.current();
      }
    };
    const key = (e: KeyboardEvent) => {
      const chord = `${e.ctrlKey || e.metaKey ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${e.shiftKey ? "Shift+" : ""}${e.key.length === 1 ? e.key.toUpperCase() : e.key}`;
      const action = items.current.find(
        (a) => !a.disabled && a.key?.split(" / ").includes(chord),
      );
      if (action) {
        e.preventDefault();
        e.stopImmediatePropagation();
        close.current();
        action.run();
        return;
      }
      if (
        e.key === "F5" ||
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r")
      )
        e.preventDefault();
      if (["Escape", "Tab", "F9"].includes(e.key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        close.current();
        return;
      }
      if (
        e.key === "ArrowDown" ||
        e.key === "ArrowUp" ||
        e.key === "Home" ||
        e.key === "End"
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const enabled = items.current
          .map((a, i) => (a.disabled ? -1 : i))
          .filter((i) => i >= 0);
        if (!enabled.length) return;
        const current = enabled.findIndex(
          (i) => buttons.current[i] === document.activeElement,
        );
        focus(
          e.key === "Home"
            ? enabled[0]
            : e.key === "End"
              ? enabled.at(-1)!
              : enabled[
                  (current + (e.key === "ArrowDown" ? 1 : enabled.length - 1)) %
                    enabled.length
                ],
        );
      } else if (
        e.key.length === 1 &&
        e.key !== " " &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const now = Date.now();
        search.current = {
          text:
            now - search.current.time > 600
              ? e.key
              : search.current.text + e.key,
          time: now,
        };
        const index = items.current.findIndex(
          (a) =>
            !a.disabled &&
            a.label
              .toLocaleLowerCase()
              .startsWith(search.current.text.toLocaleLowerCase()),
        );
        if (index >= 0) focus(index);
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
      if (restore.current && previous?.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      className="command-menu"
      data-theme={resolvedTheme}
      style={position}
    >
      {actions.map((a, i) => (
        <div key={a.id} role="none">
          {a.separator && (
            <div className="command-menu-divider" role="separator" />
          )}
          <button
            ref={(node) => {
              buttons.current[i] = node;
            }}
            type="button"
            role="menuitem"
            disabled={a.disabled}
            tabIndex={active === i ? 0 : -1}
            className={`${active === i ? "highlighted" : ""} ${a.danger ? "text-danger" : ""}`}
            onPointerMove={() => {
              if (!a.disabled && active !== i) focus(i);
            }}
            onFocus={() => setActive(i)}
            onClick={() => {
              if (a.disabled) return;
              close.current();
              a.run();
            }}
          >
            {a.icon}
            <span>{a.label}</span>
            {a.key && <kbd>{a.key}</kbd>}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
