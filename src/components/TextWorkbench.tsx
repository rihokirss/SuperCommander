import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, LoaderCircle, Search, X } from "lucide-react";
import { command } from "../api";
import type { Location } from "../types";
import type { Text } from "../i18n";
import { basename } from "../utils";
import { IconButton, Modal } from "./Primitives";

type Document = {
  text: string;
  revision: string;
  encoding: string;
  lineEnding: string;
};
export function TextWorkbench({
  location,
  t,
  editable = false,
  initial,
  truncated,
  onClose,
  onSaved,
  onEdit,
}: {
  location: Location;
  t: Text;
  editable?: boolean;
  initial?: string;
  truncated?: boolean;
  onClose: () => void;
  onSaved?: () => void;
  onEdit?: () => void;
}) {
  const [doc, setDoc] = useState<Document>();
  const [text, setText] = useState(initial || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [position, setPosition] = useState({ line: 1, col: 1 });
  const [line, setLine] = useState("");
  const [goOpen, setGoOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const dirty = editable && !!doc && text !== doc.text;
  const lines = useMemo(() => text.split("\n").length, [text]);
  const matches = useMemo(() => {
    const matches: number[] = [];
    if (!query) return matches;
    const haystack = text.toLowerCase(),
      needle = query.toLowerCase();
    for (let start = 0; matches.length < 10000; ) {
      const index = haystack.indexOf(needle, start);
      if (index < 0) break;
      matches.push(index);
      start = index + query.length;
    }
    return matches;
  }, [text, query]);
  useEffect(() => {
    let alive = true;
    command<Document>("read_document", { location })
      .then((value) => {
        if (alive) {
          setDoc(value);
          setText(value.text);
        }
      })
      .catch((e) => {
        if (alive && editable) setError(String(e));
      })
      .finally(() => {
        if (alive) {
          setBusy(false);
          requestAnimationFrame(() => area.current?.focus());
        }
      });
    return () => {
      alive = false;
    };
  }, [location.source, location.path]);
  function close() {
    if (saving.current) return;
    if (dirty && !confirm(t.discardEdits)) return;
    onClose();
  }
  async function save() {
    if (!doc || !editable || saving.current || !dirty) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const value = await command<Document>("save_document", {
        location,
        text,
        revision: doc.revision,
      });
      setDoc(value);
      setText(value.text);
      setSaved(true);
      onSaved?.();
    } catch (e) {
      setError(String(e));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  function find(previous = false) {
    const el = area.current;
    if (!el || !matches.length) return;
    const index = previous
      ? ([...matches].reverse().find((n) => n < el.selectionStart) ??
        matches.at(-1)!)
      : (matches.find((n) => n >= el.selectionEnd) ?? matches[0]);
    el.focus();
    el.setSelectionRange(index, index + query.length);
    el.scrollTop = Math.max(
      0,
      (text.slice(0, index).split("\n").length - 4) * 20,
    );
    if (gutter.current) gutter.current.scrollTop = el.scrollTop;
  }
  function openSearch(replace = false) {
    setSearchOpen(true);
    setReplaceOpen(replace && editable);
    requestAnimationFrame(() => search.current?.focus());
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const name = e.key.toLowerCase();
      if (e.key === "F10" || (!editable && e.key === "F3")) {
        e.preventDefault();
        close();
      } else if (editable && (e.key === "F2" || (ctrl && name === "s"))) {
        e.preventDefault();
        void save();
      } else if (e.key === "F7" && e.shiftKey) {
        e.preventDefault();
        find(true);
      } else if (e.key === "F7" || (ctrl && name === "f")) {
        e.preventDefault();
        openSearch();
      } else if (ctrl && name === "h" && editable) {
        e.preventDefault();
        openSearch(true);
      } else if (ctrl && name === "g") {
        e.preventDefault();
        find(e.shiftKey);
      } else if (e.key === "F8" || (!editable && e.key === "F2")) {
        e.preventDefault();
        setWrap((v) => !v);
      } else if (e.key === "F6") {
        e.preventDefault();
        setGoOpen((v) => !v);
      } else if (!editable && e.key === "F4" && onEdit) {
        e.preventDefault();
        onEdit();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });
  function updatePosition() {
    const before = text.slice(0, area.current?.selectionStart || 0).split("\n");
    setPosition({ line: before.length, col: before.at(-1)!.length + 1 });
  }
  return (
    <Modal
      title={`${basename(location.path)}${dirty ? " •" : ""}`}
      subtitle={`${editable ? t.edit : t.view} · ${location.path}`}
      full
      onClose={close}
    >
      <div className="text-toolbar">
        <span>
          {doc?.encoding || "UTF-8"} · {doc?.lineEnding || "LF"}
        </span>
        <span>
          {lines.toLocaleString()} {t.lines}
        </span>
        <span>
          {t.line} {position.line}, {t.column} {position.col}
        </span>
        {busy ? (
          <LoaderCircle size={13} className="spin" />
        ) : dirty ? (
          <span className="editor-dirty">{t.modifiedText}</span>
        ) : saved ? (
          <span>{t.savedText}</span>
        ) : null}
        {!doc && truncated && <span>{t.truncated}</span>}
      </div>
      {searchOpen && (
        <div className="text-search">
          <Search size={14} />
          <input
            ref={search}
            aria-label={t.findText}
            placeholder={t.findText}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                find(e.shiftKey);
              }
            }}
          />
          <span>
            {matches.length === 10000 ? "10000+" : matches.length} {t.matches}
          </span>
          <IconButton
            title={`${t.previousMatch} · Shift+F7`}
            onClick={() => find(true)}
          >
            <ChevronUp size={14} />
          </IconButton>
          <IconButton title={`${t.nextMatch} · Ctrl+G`} onClick={() => find()}>
            <ChevronDown size={14} />
          </IconButton>
          {replaceOpen && (
            <>
              <input
                aria-label={t.replace}
                placeholder={t.replace}
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
              />
              <button
                disabled={!query || !doc || busy}
                onClick={() => {
                  const el = area.current;
                  if (!el) return;
                  if (
                    text
                      .slice(el.selectionStart, el.selectionEnd)
                      .toLowerCase() !== query.toLowerCase()
                  ) {
                    find();
                    return;
                  }
                  el.focus();
                  document.execCommand("insertText", false, replacement);
                  setSaved(false);
                }}
              >
                {t.replace}
              </button>
            </>
          )}
          <IconButton
            title={t.close}
            onClick={() => {
              setSearchOpen(false);
              area.current?.focus();
            }}
          >
            <X size={13} />
          </IconButton>
        </div>
      )}
      {goOpen && (
        <form
          className="text-search"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Math.max(1, Math.min(lines, Number(line)));
            const index = text
              .split("\n")
              .slice(0, n - 1)
              .reduce((sum, l) => sum + l.length + 1, 0);
            area.current?.focus();
            area.current?.setSelectionRange(index, index);
            if (area.current)
              area.current.scrollTop = Math.max(0, (n - 4) * 20);
            setGoOpen(false);
          }}
        >
          <label>
            {t.goToLine}{" "}
            <input
              aria-label={t.goToLine}
              autoFocus
              type="number"
              min={1}
              max={lines}
              value={line}
              onChange={(e) => setLine(e.target.value)}
            />
          </label>
          <button>{t.goToLine}</button>
        </form>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className={`text-surface ${wrap ? "wrapped" : ""}`}>
        {!wrap && (
          <div ref={gutter} className="line-gutter" aria-hidden="true">
            <pre style={{ transform: `translateY(-${scrollTop % 20}px)` }}>
              {Array.from(
                {
                  length: Math.max(
                    0,
                    Math.min(300, lines - Math.floor(scrollTop / 20)),
                  ),
                },
                (_, i) => Math.floor(scrollTop / 20) + i + 1,
              ).join("\n")}
            </pre>
          </div>
        )}
        <textarea
          ref={area}
          aria-label={editable ? t.editorContent : t.viewerContent}
          data-file-text
          spellCheck={false}
          wrap={wrap ? "soft" : "off"}
          value={text}
          readOnly={!editable || !doc || busy}
          onChange={(e) => {
            setText(e.target.value);
            setSaved(false);
          }}
          onKeyDown={(e) => {
            if (editable && doc && !busy && e.key === "Tab" && !e.shiftKey) {
              e.preventDefault();
              document.execCommand("insertText", false, "\t");
            }
          }}
          onSelect={updatePosition}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        />
      </div>
      <footer className="workbench-keys">
        {editable ? (
          <button disabled={!dirty || busy} onClick={() => void save()}>
            <kbd>F2</kbd>
            {t.saveChanges}
            <small>Ctrl+S</small>
          </button>
        ) : (
          <button onClick={onEdit} disabled={!onEdit}>
            <kbd>F4</kbd>
            {t.edit}
          </button>
        )}
        <button
          onClick={() => {
            setGoOpen((v) => !v);
          }}
        >
          <kbd>F6</kbd>
          {t.goToLine}
        </button>
        <button onClick={() => openSearch()}>
          <kbd>F7</kbd>
          {t.findText}
        </button>
        <button
          className={wrap ? "pressed" : ""}
          onClick={() => setWrap((v) => !v)}
        >
          <kbd>F8</kbd>
          {t.wordWrap}
        </button>
        {editable && (
          <button onClick={() => openSearch(true)}>
            <kbd>Ctrl+H</kbd>
            {t.replace}
          </button>
        )}
        <button onClick={close}>
          <kbd>F10</kbd>
          {t.close}
          <small>Esc</small>
        </button>
      </footer>
    </Modal>
  );
}
