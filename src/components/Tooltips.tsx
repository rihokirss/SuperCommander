import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export function Tooltips() {
  const [tip, setTip] = useState<{
    text: string;
    shortcut: string;
    x: number;
    y: number;
    above: boolean;
    theme: string;
  }>();
  useEffect(() => {
    let target: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const hide = () => {
      clearTimeout(timer);
      setTip(undefined);
      target = null;
    };
    const hasNativeTip = (element: Element, node: HTMLElement) => {
      const titled = (item: Element) =>
        !!item.closest("[title]")?.getAttribute("title");
      // Focus events target the button even when its icon owns the pointer's
      // native hint. Check the deepest hovered descendant as well.
      const hovered = Array.from(node.querySelectorAll(":hover")).at(-1);
      return titled(element) || (!!hovered && titled(hovered));
    };
    const show = (event: Event) => {
      const element = event.target;
      if (!(element instanceof Element)) return;
      // The whole button owns its hint, including events from its icon or label.
      const node =
        element.closest<HTMLElement>("button") ||
        element.closest<HTMLElement>("[data-tooltip]");
      if (!node) {
        hide();
        return;
      }
      // Native titles can also come from an icon, label or ancestor of the button.
      // An empty title explicitly stops native title inheritance.
      if (hasNativeTip(element, node)) {
        hide();
        return;
      }
      if (node === target) return;
      hide();
      target = node;
      if (
        node.matches('[role="menuitem"],[role="option"]') &&
        !node.dataset.tooltip
      )
        return;
      const text =
        node.dataset.tooltip ||
        node.getAttribute("aria-label") ||
        node.textContent?.trim();
      if (!text) return;
      timer = setTimeout(() => {
        if (!node.isConnected || hasNativeTip(element, node)) return;
        const rect = node.getBoundingClientRect();
        const above = rect.bottom > innerHeight - 55;
        setTip({
          text,
          shortcut: node.dataset.shortcut || "",
          x: Math.max(
            150,
            Math.min(innerWidth - 150, rect.left + rect.width / 2),
          ),
          y: above ? rect.top - 8 : rect.bottom + 8,
          above,
          theme:
            node.closest<HTMLElement>(".app-shell")?.dataset.theme || "dark",
        });
      }, 350);
    };
    const leave = (event: Event) => {
      const next = (event as PointerEvent).relatedTarget;
      if (!target?.contains(next as Node)) hide();
    };
    document.addEventListener("pointerover", show);
    document.addEventListener("focusin", show);
    document.addEventListener("pointerout", leave);
    document.addEventListener("focusout", hide);
    document.addEventListener("pointerdown", hide);
    document.addEventListener("keydown", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", show);
      document.removeEventListener("focusin", show);
      document.removeEventListener("pointerout", leave);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("pointerdown", hide);
      document.removeEventListener("keydown", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, []);
  return tip
    ? createPortal(
        <div
          role="tooltip"
          className={`app-tooltip ${tip.above ? "above" : ""}`}
          data-theme={tip.theme}
          style={{ left: tip.x, top: tip.y }}
        >
          <span>{tip.text}</span>
          {tip.shortcut && <kbd>{tip.shortcut}</kbd>}
        </div>,
        document.body,
      )
    : null;
}
