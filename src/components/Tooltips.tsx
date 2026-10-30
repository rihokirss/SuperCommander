import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function Tooltips() {
  const popup = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{
    text: string;
    shortcut: string;
    x: number;
    y: number;
    above: boolean;
    theme: string;
    anchor: { x: number; top: number; bottom: number };
  }>();
  useLayoutEffect(() => {
    if (!tip || !popup.current) return;
    const { width, height } = popup.current.getBoundingClientRect();
    const x = Math.max(8 + width / 2, Math.min(innerWidth - 8 - width / 2, tip.anchor.x));
    const above = tip.anchor.bottom + 8 + height > innerHeight - 8 && tip.anchor.top - 8 - height >= 8;
    const y = above ? tip.anchor.top - 8 : Math.max(8, Math.min(innerHeight - 8 - height, tip.anchor.bottom + 8));
    if (x !== tip.x || y !== tip.y || above !== tip.above)
      setTip((current) => current === tip ? { ...tip, x, y, above } : current);
  }, [tip]);
  useEffect(() => {
    let target: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout>;
    let nativeHints: MutationObserver | undefined;
    const hide = () => {
      clearTimeout(timer);
      nativeHints?.disconnect();
      setTip(undefined);
      target = null;
    };
    const hasNativeTip = (element: Element, node: HTMLElement) => {
      const titled = (item: Element) => {
        if (item.closest("[title]")?.getAttribute("title")) return true;
        // SVG uses a child <title>, independently of the HTML title attribute.
        for (
          let svg = item.closest("svg");
          svg;
          svg = svg.parentElement?.closest("svg") ?? null
        )
          if (svg.querySelector(":scope > title")?.textContent?.trim())
            return true;
        return false;
      };
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
      // A native hint may be added while our hint is pending or already visible.
      // Observe just this control's subtree and its ancestors' title attributes.
      nativeHints = new MutationObserver(() => {
        if (hasNativeTip(element, node)) hide();
      });
      nativeHints.observe(node, {
        attributes: true,
        attributeFilter: ["title"],
        childList: true,
        characterData: true,
        subtree: true,
      });
      for (
        let parent = node.parentElement;
        parent;
        parent = parent.parentElement
      )
        nativeHints.observe(parent, {
          attributes: true,
          attributeFilter: ["title"],
        });
      timer = setTimeout(() => {
        if (!node.isConnected || hasNativeTip(element, node)) return;
        const rect = node.getBoundingClientRect();
        const above = rect.bottom > innerHeight - 55;
        setTip({
          text,
          shortcut: node.dataset.shortcut || "",
          x: rect.left + rect.width / 2,
          y: above ? rect.top - 8 : rect.bottom + 8,
          above,
          theme:
            node.closest<HTMLElement>(".app-shell")?.dataset.theme || "dark",
          anchor: { x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom },
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
    window.addEventListener("resize", hide);
    return () => {
      clearTimeout(timer);
      nativeHints?.disconnect();
      document.removeEventListener("pointerover", show);
      document.removeEventListener("focusin", show);
      document.removeEventListener("pointerout", leave);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("pointerdown", hide);
      document.removeEventListener("keydown", hide);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);
  return tip
    ? createPortal(
        <div
          ref={popup}
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
