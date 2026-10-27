import { useLayoutEffect, useRef, type ReactNode } from "react";
import {
  X,
  Folder,
  FileText,
  FileCode2,
  FileImage,
  FileArchive,
  File,
  FileMusic,
  FileVideo,
  FileSpreadsheet,
  Link2,
  CornerLeftUp,
} from "lucide-react";
import type { Entry } from "../types";
import { extension } from "../utils";
export function IconButton({
  title,
  children,
  onClick,
  disabled,
  className = "",
  shortcut,
}: {
  title: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  shortcut?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      data-tooltip={title}
      data-shortcut={shortcut}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export function FileIcon({ entry }: { entry: Entry }) {
  if (entry.isParent)
    return (
      <span className="file-icon folder">
        <CornerLeftUp size={17} strokeWidth={1.4} />
      </span>
    );
  const ext = extension(entry);
  const [Icon, color] = entry.isDir
    ? [Folder, "folder"]
    : /^(png|jpg|jpeg|webp|gif|bmp|svg)$/.test(ext)
      ? [FileImage, "image"]
      : /^(rs|js|ts|tsx|jsx|json|toml|html|css|py|sh|ps1)$/.test(ext)
        ? [FileCode2, "code"]
        : /^(zip|7z|rar|gz)$/.test(ext)
          ? [FileArchive, "archive"]
          : /^(mp3|wav|flac)$/.test(ext)
            ? [FileMusic, "audio"]
            : /^(mp4|mov|mkv)$/.test(ext)
              ? [FileVideo, "video"]
              : /^(xlsx|csv)$/.test(ext)
                ? [FileSpreadsheet, "sheet"]
                : /^(md|txt|pdf|log|ini)$/.test(ext)
                  ? [FileText, ext === "pdf" ? "pdf" : "text"]
                  : [File, "text"];
  return (
    <span className={`file-icon ${color}`}>
      <Icon size={19} strokeWidth={1.55} />
      {entry.isSymlink && <Link2 size={9} className="symlink-badge" />}
    </span>
  );
}
export function Modal({
  title,
  subtitle,
  closeLabel,
  children,
  onClose,
  wide = false,
  full = false,
}: {
  title: string;
  subtitle?: string;
  closeLabel: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  full?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Capture before autoFocus inputs mount; afterwards activeElement may already be inside this dialog.
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const previous = previousFocus.current;
    const node = ref.current;
    (
      node?.querySelector<HTMLElement>(
        'button[role="combobox"],input:not([type="checkbox"]),textarea,select',
      ) || node?.querySelector<HTMLElement>("button")
    )?.focus();
    const key = (e: KeyboardEvent) => {
      const dialogs = document.querySelectorAll(
        '[role="dialog"][aria-modal="true"]',
      );
      if (dialogs[dialogs.length - 1] !== node) return;
      if (e.key === "Escape") {
        if (document.querySelector('[data-select-open="true"]')) return;
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === "Tab") {
        const elements = node?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea, [tabindex="0"]',
        );
        if (!elements?.length) return;
        const first = elements[0],
          last = elements[elements.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      if (previous?.isConnected) previous.focus();
      else
        document
          .querySelector<HTMLElement>(".file-pane.active .file-grid")
          ?.focus();
    };
  }, []);
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal glass ${wide ? "wide" : ""} ${full ? "file-workbench" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <IconButton title={closeLabel} shortcut="Esc" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        {children}
      </div>
    </div>
  );
}
