import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export function Select({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    width: 140,
    theme: "dark",
  });
  function reveal() {
    const rect = button.current!.getBoundingClientRect();
    const height = options.length * 33 + 10;
    setPosition({
      left: Math.min(rect.left, innerWidth - Math.max(140, rect.width) - 10),
      top:
        rect.bottom + height > innerHeight
          ? rect.top - height - 5
          : rect.bottom + 5,
      width: Math.max(140, rect.width),
      theme:
        button.current!.closest<HTMLElement>(".app-shell")?.dataset.theme ||
        "dark",
    });
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    setOpen(true);
  }
  function choose(index: number) {
    if (options[index]) onChange(options[index].value);
    setOpen(false);
    button.current?.focus();
  }
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (
        !button.current?.contains(e.target as Node) &&
        !popup.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    const hide = () => setOpen(false);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", hide);
    };
  }, [open]);
  return (
    <>
      <button
        ref={button}
        type="button"
        disabled={disabled}
        className={`select-control ${open ? "open" : ""}`}
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        data-select-open={open}
        onClick={() => (open ? setOpen(false) : reveal())}
        onKeyDown={(e) => {
          if (
            [
              "ArrowDown",
              "ArrowUp",
              "Home",
              "End",
              "Enter",
              " ",
              "Escape",
            ].includes(e.key)
          ) {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Escape") {
              setOpen(false);
              return;
            }
            if (!open) {
              reveal();
              return;
            }
            if (e.key === "Enter" || e.key === " ") {
              choose(active);
              return;
            }
            setActive((n) =>
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? options.length - 1
                  : Math.max(
                      0,
                      Math.min(
                        options.length - 1,
                        n + (e.key === "ArrowDown" ? 1 : -1),
                      ),
                    ),
            );
          } else if (e.key === "Tab") setOpen(false);
          else if (
            e.key.length === 1 &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.altKey
          ) {
            const index = options.findIndex((o) =>
              o.label.toLocaleLowerCase().startsWith(e.key.toLocaleLowerCase()),
            );
            if (index >= 0) {
              if (open) setActive(index);
              else onChange(options[index].value);
            }
          }
        }}
      >
        <span>{options.find((o) => o.value === value)?.label || value}</span>
        <ChevronDown size={13} />
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            id={id}
            role="listbox"
            aria-label={label}
            className="select-options"
            data-theme={position.theme}
            style={{
              left: position.left,
              top: position.top,
              minWidth: position.width,
            }}
          >
            {options.map((option, index) => (
              <div
                key={option.value}
                id={`${id}-${index}`}
                role="option"
                aria-selected={option.value === value}
                className={index === active ? "highlighted" : ""}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(index)}
              >
                <span>{option.label}</span>
                {option.value === value && <Check size={13} />}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
