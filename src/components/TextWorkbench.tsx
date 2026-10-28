import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, LoaderCircle, Search, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { command, desktop } from "../api";
import type { Location, TextPosition } from "../types";
import type { Text } from "../i18n";
import { basename, parent, join } from "../utils";
import { IconButton, Modal } from "./Primitives";
import { Select } from "./Select";
import { shortcutGroups } from "../shortcuts";
import { textMatches } from "../textMatches";
import { indentEdit } from "../editor";

type Document = {
  text: string;
  revision: string;
  encoding: string;
  lineEnding: string;
  connection?: string | null;
};
export type SaveDestination = { source: string; folder: string; label: string };
export function TextWorkbench({
  location,
  t,
  editable = false,
  initial,
  truncated,
  onClose,
  onSaved,
  onEdit,
  newFile = false,
  destinations = [],
  initialLine = 1,
  initialColumn = 1,
  initialEncoding = "UTF-8",
  initialLineEnding = "LF",
  lineOffset = 0,
  connection,
  onGotoLine,
  onPage,
  hasPrevious,
  hasNext,
  initialSelectionLength = 0,
  initialVersion = 0,
  viewLoading = false,
  viewError,
  findStatus,
  findLoading = false,
  onFind,
  onCancelFind,
}: {
  location: Location;
  t: Text;
  editable?: boolean;
  initial?: string;
  truncated?: boolean;
  onClose: () => void;
  onSaved?: () => void;
  onEdit?: (line?: number, column?: number) => void;
  newFile?: boolean;
  destinations?: SaveDestination[];
  initialLine?: number;
  initialColumn?: number;
  initialEncoding?: string;
  initialLineEnding?: string;
  lineOffset?: number;
  connection?: string | null;
  onGotoLine?: (line: number) => void;
  onPage?: (delta: number) => void;
  hasPrevious?: boolean;
  hasNext?: boolean;
  initialSelectionLength?: number;
  initialVersion?: number;
  viewLoading?: boolean;
  viewError?: string;
  findStatus?: string;
  findLoading?: boolean;
  onFind?: (query: string, from: TextPosition, previous: boolean) => void;
  onCancelFind?: () => void;
}) {
  const [fileLocation, setFileLocation] = useState<Location | undefined>(
    newFile ? undefined : location,
  );
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
  const [encoding, setEncoding] = useState("UTF-8");
  const [lineEnding, setLineEnding] = useState("LF");
  const [closeIntent, setCloseIntent] = useState<"editor" | "window">();
  const [saveAs, setSaveAs] = useState<{
    source: string;
    path: string;
    encoding: string;
    lineEnding: string;
  }>();
  const [overwrite, setOverwrite] = useState<{
    location: Location;
    revision: string;
    connection?: string | null;
    format: { encoding: string; lineEnding: string };
  }>();
  const [formError, setFormError] = useState("");
  const [help, setHelp] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const savePath = useRef<HTMLInputElement>(null);
  const closing = useRef(false);
  const lifecycle = useRef({
    dirty: false,
    request: (_intent: "editor" | "window") => {},
  });
  const dirty =
    editable &&
    !!doc &&
    (text !== doc.text ||
      encoding !== doc.encoding ||
      lineEnding !== doc.lineEnding);
  lifecycle.current = { dirty, request: requestClose };
  const lines = useMemo(() => text.split("\n").length, [text]);
  const matches = useMemo(() => textMatches(text, query), [text, query]);
  useEffect(() => {
    let alive = true;
    const load =
      !editable && initial !== undefined
        ? Promise.resolve({
            text: initial,
            revision: "",
            encoding: initialEncoding,
            lineEnding: initialLineEnding,
          })
        : newFile && !desktop
          ? Promise.resolve({
              text: "",
              revision: "",
              encoding: "UTF-8",
              lineEnding: "CRLF",
            })
          : command<Document>(
              newFile ? "new_document" : "read_document",
              newFile ? { folder: location } : { location, connection },
            );
    load
      .then((value) => {
        if (alive) {
          setDoc(value);
          setText(value.text);
          setEncoding(value.encoding);
          setLineEnding(value.lineEnding);
        }
      })
      .catch((e) => {
        if (alive && editable) setError(String(e));
      })
      .finally(() => {
        if (alive) {
          setBusy(false);
          requestAnimationFrame(() => {
            if (!alive) return;
            const element = area.current;
            if (!element) return;
            element.focus();
            const rows = element.value.split("\n");
            const row = Math.max(
              0,
              Math.min(rows.length - 1, initialLine - lineOffset - 1),
            );
            const index =
              rows
                .slice(0, row)
                .reduce((sum, text) => sum + text.length + 1, 0) +
              Array.from(rows[row])
                .slice(0, Math.max(0, initialColumn - 1))
                .join("").length;
            element.setSelectionRange(index, index + initialSelectionLength);
            element.scrollTop = Math.max(0, (row - 4) * 20);
            setPosition({ line: row + lineOffset + 1, col: initialColumn });
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [location.source, location.path, newFile, initial, initialVersion]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (lifecycle.current.dirty && !closing.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    const listener =
      desktop && editable
        ? getCurrentWindow().onCloseRequested((event) => {
            if (lifecycle.current.dirty || saving.current) {
              event.preventDefault();
              lifecycle.current.request("window");
            }
          })
        : undefined;
    return () => {
      window.removeEventListener("beforeunload", unload);
      void listener?.then((unlisten) => unlisten());
    };
  }, [editable]);
  useEffect(() => {
    if (saveAs && !overwrite)
      requestAnimationFrame(() => {
        savePath.current?.focus();
        savePath.current?.select();
      });
  }, [!!saveAs, !!overwrite]);
  async function finishClose(intent: "editor" | "window") {
    closing.current = true;
    if (intent === "window" && desktop) {
      try {
        await getCurrentWindow().destroy();
      } catch (e) {
        closing.current = false;
        setError(String(e));
      }
    } else onClose();
  }
  function requestClose(intent: "editor" | "window") {
    if (saving.current) return;
    if (dirty) setCloseIntent(intent);
    else void finishClose(intent);
  }
  function close() {
    requestClose("editor");
  }
  function openSaveAs() {
    if (!doc || saving.current) return;
    setFormError("");
    setOverwrite(undefined);
    setSaveAs({
      source: fileLocation?.source || location.source,
      path: fileLocation?.path || join(location.path, "Untitled.txt"),
      encoding,
      lineEnding,
    });
  }
  async function persist(
    target: Location,
    revision: string | null,
    connection?: string | null,
    format = { encoding, lineEnding },
  ) {
    if (!doc || !editable || saving.current) return false;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const value = await command<Document>("write_document", {
        location: target,
        text,
        revision,
        connection: connection ?? null,
        format,
      });
      setDoc(value);
      setText(value.text);
      setEncoding(value.encoding);
      setLineEnding(value.lineEnding);
      setFileLocation(target);
      setSaveAs(undefined);
      setOverwrite(undefined);
      setSaved(true);
      onSaved?.();
      if (closeIntent) await finishClose(closeIntent);
      return true;
    } catch (e) {
      setError(String(e));
      setFormError(String(e));
      setOverwrite(undefined);
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  async function save() {
    if (!doc || !editable || saving.current) return;
    if (!fileLocation || !doc.revision) {
      openSaveAs();
      return;
    }
    if (dirty) await persist(fileLocation, doc.revision, doc.connection);
  }
  async function submitSaveAs() {
    if (!saveAs || !doc || saving.current) return;
    const input = saveAs.path;
    if (!input.trim()) {
      setFormError(t.enterFilePath);
      return;
    }
    const base =
      saveAs.source === (fileLocation?.source || location.source)
        ? fileLocation
          ? parent(fileLocation.path)
          : location.path
        : destinations.find((d) => d.source === saveAs.source)?.folder || "/";
    const absolute = /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(input);
    const target = {
      source: saveAs.source,
      path: absolute ? input : join(base, input),
    };
    if (
      target.source === "local" &&
      /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(target.path)
    )
      target.path = target.path.replaceAll("/", "\\");
    setFormError("");
    saving.current = true;
    setBusy(true);
    try {
      const result = await command<{
        revision: string | null;
        connection?: string | null;
      }>("document_target", {
        location: target,
        connection:
          target.source === (fileLocation?.source || location.source)
            ? (doc.connection ?? null)
            : null,
      });
      saving.current = false;
      setBusy(false);
      if (result.revision !== null)
        setOverwrite({
          location: target,
          revision: result.revision,
          connection: result.connection,
          format: { encoding: saveAs.encoding, lineEnding: saveAs.lineEnding },
        });
      else
        await persist(target, null, result.connection, {
          encoding: saveAs.encoding,
          lineEnding: saveAs.lineEnding,
        });
    } catch (e) {
      setFormError(String(e));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  function find(previous = false) {
    const el = area.current;
    if (!el || !query || viewLoading) return;
    if (!editable && onFind) {
      const before = text
        .slice(0, previous ? el.selectionStart : el.selectionEnd)
        .split("\n");
      onFind(
        query,
        {
          line: lineOffset + before.length,
          column: Array.from(before.at(-1)!).length + 1,
        },
        previous,
      );
      return;
    }
    if (!matches.length) return;
    const match = previous
      ? ([...matches].reverse().find((n) => n.start < el.selectionStart) ??
        matches.at(-1)!)
      : (matches.find((n) => n.start >= el.selectionEnd) ?? matches[0]);
    el.focus();
    el.setSelectionRange(match.start, match.end);
    el.scrollTop = Math.max(
      0,
      (text.slice(0, match.start).split("\n").length - 4) * 20,
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
      const dialogs = document.querySelectorAll(
        '[role="dialog"][aria-modal="true"]',
      );
      if (
        dialogs[dialogs.length - 1] !== area.current?.closest('[role="dialog"]')
      ) {
        if (ctrl && name === "s") e.preventDefault();
        return;
      }
      if (e.altKey) return;
      if (
        (e.key === "F10" && !ctrl) ||
        (ctrl && name === "w") ||
        (!editable && e.key === "F3" && !ctrl)
      ) {
        e.preventDefault();
        close();
      } else if (
        editable &&
        ((e.key === "F2" && !ctrl) || (ctrl && name === "s"))
      ) {
        e.preventDefault();
        if (e.shiftKey) openSaveAs();
        else void save();
      } else if (e.key === "F1" && !ctrl) {
        e.preventDefault();
        setHelp(true);
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
        onEdit(position.line, position.col);
      } else if (
        !editable &&
        ctrl &&
        ["PageUp", "PageDown"].includes(e.key) &&
        onPage
      ) {
        e.preventDefault();
        if (!viewLoading && e.key === "PageUp" && hasPrevious) onPage(-1);
        if (!viewLoading && e.key === "PageDown" && hasNext) onPage(1);
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });
  function updatePosition() {
    const before = text.slice(0, area.current?.selectionStart || 0).split("\n");
    setPosition({
      line: before.length + lineOffset,
      col: Array.from(before.at(-1)!).length + 1,
    });
  }
  const encodingControl = (dialog = false) => (
    <Select
      label={t.encoding}
      value={dialog && saveAs ? saveAs.encoding : encoding}
      options={["UTF-8", "UTF-8 BOM", "UTF-16 LE", "UTF-16 BE"].map(
        (value) => ({ value, label: value }),
      )}
      onChange={(value) => {
        if (saving.current) return;
        if (dialog && saveAs) setSaveAs({ ...saveAs, encoding: value });
        else {
          setEncoding(value);
          setSaved(false);
        }
      }}
    />
  );
  const lineEndingControl = (dialog = false) => (
    <Select
      label={t.lineEndings}
      value={dialog && saveAs ? saveAs.lineEnding : lineEnding}
      options={[
        { value: "CRLF", label: "CRLF (Windows)" },
        { value: "LF", label: "LF (Unix)" },
      ]}
      onChange={(value) => {
        if (saving.current) return;
        if (dialog && saveAs) setSaveAs({ ...saveAs, lineEnding: value });
        else {
          setLineEnding(value);
          setSaved(false);
        }
      }}
    />
  );
  const formatControls = () => (
    <>
      {encodingControl()}
      {lineEndingControl()}
    </>
  );
  const saveSources = [...destinations];
  const ownSource = fileLocation?.source || location.source;
  if (!saveSources.some((d) => d.source === ownSource))
    saveSources.push({
      source: ownSource,
      folder: fileLocation ? parent(fileLocation.path) : location.path,
      label: ownSource === "local" ? t.local : t.remoteFiles,
    });
  return (
    <>
      <Modal
        closeLabel={t.close}
        title={`${fileLocation ? basename(fileLocation.path) : t.untitled}${dirty ? " •" : ""}`}
        subtitle={`${editable ? t.edit : t.view} · ${fileLocation?.path || location.path}`}
        full
        onClose={close}
      >
        <div className="text-toolbar">
          {editable ? (
            <fieldset className="editor-format" disabled={busy || !doc}>
              {formatControls()}
            </fieldset>
          ) : (
            <span>
              {doc?.encoding || "UTF-8"} · {doc?.lineEnding || "LF"}
            </span>
          )}
          <span>
            {lines.toLocaleString()} {t.lines}
          </span>
          <span>
            {t.line} {position.line}, {t.column} {position.col}
          </span>
          {busy || viewLoading ? (
            <LoaderCircle size={13} className="spin" />
          ) : dirty ? (
            <span className="editor-dirty">{t.modifiedText}</span>
          ) : saved ? (
            <span>{t.savedText}</span>
          ) : null}
          {truncated && <span>{t.truncated}</span>}
          {!editable && onPage && (
            <div className="text-page-controls">
              <IconButton
                title={t.previousTextPage}
                shortcut="Ctrl+PgUp"
                disabled={!hasPrevious || viewLoading}
                onClick={() => onPage(-1)}
              >
                <ChevronUp size={14} />
              </IconButton>
              <IconButton
                title={t.nextTextPage}
                shortcut="Ctrl+PgDn"
                disabled={!hasNext || viewLoading}
                onClick={() => onPage(1)}
              >
                <ChevronDown size={14} />
              </IconButton>
            </div>
          )}
        </div>
        {searchOpen && (
          <div className="text-search">
            <Search size={14} />
            <input
              ref={search}
              aria-label={t.findText}
              placeholder={t.findText}
              value={query}
              onChange={(e) => {
                onCancelFind?.();
                setQuery(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  find(e.shiftKey);
                }
              }}
            />
            <span role="status">
              {!editable && onFind
                ? findStatus || t.wholeFile
                : `${matches.length === 10000 ? "10000+" : matches.length} ${t.matches}`}
            </span>
            <IconButton
              title={`${t.previousMatch} · Shift+F7`}
              disabled={!query || viewLoading}
              onClick={() => find(true)}
            >
              <ChevronUp size={14} />
            </IconButton>
            <IconButton
              title={`${t.nextMatch} · Ctrl+G`}
              disabled={!query || viewLoading}
              onClick={() => find()}
            >
              <ChevronDown size={14} />
            </IconButton>
            {!editable && findLoading && (
              <button onClick={onCancelFind} disabled={!onFind}>
                {t.cancel}
              </button>
            )}
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
                      !matches.some(
                        (match) =>
                          match.start === el.selectionStart &&
                          match.end === el.selectionEnd,
                      )
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
                onCancelFind?.();
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
              if (!editable && onGotoLine) {
                const requested = Number(line);
                if (Number.isSafeInteger(requested) && requested > 0) {
                  setGoOpen(false);
                  onGotoLine(requested);
                }
                return;
              }
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
                max={onGotoLine && !editable ? undefined : lines}
                value={line}
                onChange={(e) => setLine(e.target.value)}
              />
            </label>
            <button>{t.goToLine}</button>
          </form>
        )}
        {(error || viewError) && (
          <p className="inline-error" role="alert">
            {error || viewError}
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
                  (_, i) => Math.floor(scrollTop / 20) + i + 1 + lineOffset,
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
              if (
                editable &&
                doc &&
                !busy &&
                e.key === "Tab" &&
                !e.ctrlKey &&
                !e.metaKey &&
                !e.altKey
              ) {
                e.preventDefault();
                const el = e.currentTarget;
                if (!e.shiftKey && el.selectionStart === el.selectionEnd)
                  document.execCommand("insertText", false, "\t");
                else {
                  const change = indentEdit(
                    text,
                    el.selectionStart,
                    el.selectionEnd,
                    e.shiftKey,
                  );
                  el.setSelectionRange(change.from, change.to);
                  document.execCommand("insertText", false, change.text);
                  el.setSelectionRange(
                    change.selectionStart,
                    change.selectionEnd,
                  );
                }
              }
            }}
            onSelect={updatePosition}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          />
        </div>
        <footer className="workbench-keys">
          {editable ? (
            <button
              disabled={!doc || (!dirty && !!doc.revision) || busy}
              onClick={() => void save()}
            >
              <kbd>F2</kbd>
              {t.saveChanges}
              <small>Ctrl+S</small>
            </button>
          ) : (
            <button
              onClick={() => onEdit?.(position.line, position.col)}
              disabled={!onEdit}
            >
              <kbd>F4</kbd>
              {t.edit}
            </button>
          )}
          {editable && (
            <button
              disabled={!doc || busy}
              onClick={openSaveAs}
              data-tooltip={t.saveAs}
              data-shortcut="Ctrl+Shift+S / Shift+F2"
            >
              <kbd>⇧F2</kbd>
              {t.saveAs}
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
      {closeIntent && !saveAs && (
        <Modal
          closeLabel={t.cancel}
          title={t.saveBeforeClose}
          subtitle={fileLocation?.path || t.untitled}
          onClose={() => setCloseIntent(undefined)}
        >
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button onClick={() => setCloseIntent(undefined)} disabled={busy}>
              {t.cancel}
            </button>
            <button
              onClick={() => void finishClose(closeIntent)}
              disabled={busy}
            >
              {t.discardChanges}
            </button>
            <button
              className="primary"
              onClick={() => void save()}
              disabled={busy || !doc}
            >
              {t.saveChanges}
            </button>
          </div>
        </Modal>
      )}
      {saveAs && (
        <Modal
          closeLabel={t.cancel}
          title={t.saveAs}
          onClose={() => {
            if (!saving.current) {
              setSaveAs(undefined);
              setOverwrite(undefined);
              setCloseIntent(undefined);
            }
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitSaveAs();
            }}
          >
            <fieldset className="editor-save-fields" disabled={busy}>
              <label className="field">
                {t.destinationSource}
                <Select
                  label={t.destinationSource}
                  value={saveAs.source}
                  options={saveSources.map((d) => ({
                    value: d.source,
                    label: d.label,
                  }))}
                  onChange={(source) => {
                    if (saving.current) return;
                    const dest = saveSources.find((d) => d.source === source)!;
                    setSaveAs({
                      ...saveAs,
                      source,
                      path: join(
                        dest.folder,
                        fileLocation
                          ? basename(fileLocation.path)
                          : "Untitled.txt",
                      ),
                    });
                    setOverwrite(undefined);
                    setFormError("");
                  }}
                />
              </label>
              <label className="field">
                {t.saveFilePath}
                <input
                  ref={savePath}
                  autoFocus
                  value={saveAs.path}
                  onChange={(event) => {
                    setSaveAs({ ...saveAs, path: event.target.value });
                    setOverwrite(undefined);
                  }}
                />
              </label>
              <div className="editor-format-fields">
                <label className="field">
                  {t.encoding}
                  {encodingControl(true)}
                </label>
                <label className="field">
                  {t.lineEndings}
                  {lineEndingControl(true)}
                </label>
              </div>
            </fieldset>
            {formError && (
              <p className="inline-error" role="alert">
                {formError}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setSaveAs(undefined);
                  setCloseIntent(undefined);
                }}
              >
                {t.cancel}
              </button>
              <button className="primary" disabled={busy}>
                {busy ? <LoaderCircle size={14} className="spin" /> : null}
                {t.saveChanges}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {overwrite && (
        <Modal
          closeLabel={t.cancel}
          title={t.overwriteFile}
          subtitle={overwrite.location.path}
          onClose={() => setOverwrite(undefined)}
        >
          <p className="helper">{t.overwriteFileHint}</p>
          <div className="modal-actions">
            <button disabled={busy} onClick={() => setOverwrite(undefined)}>
              {t.cancel}
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void persist(
                  overwrite.location,
                  overwrite.revision,
                  overwrite.connection,
                  overwrite.format,
                )
              }
            >
              {t.replace}
            </button>
          </div>
        </Modal>
      )}
      {help && (
        <Modal
          closeLabel={t.close}
          title={t.textTools}
          onClose={() => setHelp(false)}
        >
          <div className="shortcut-grid editor-shortcuts">
            {shortcutGroups(t)
              .find((group) => group.title === t.textTools)!
              .items.map(([key, label]) => (
                <div key={key}>
                  <span>{label}</span>
                  <kbd>{key}</kbd>
                </div>
              ))}
          </div>
        </Modal>
      )}
    </>
  );
}
